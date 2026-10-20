/**
 * 回环防护（防止 A→B→A 无限循环）。
 *
 * 三层机制，从强到弱：
 *  1. 回显 ID：发出消息后记住目标侧返回的 messageId；该消息若被网关作为"新入站消息"回推，
 *     直接识别为自身回显。这是最可靠的一层，要求网关返回 messageId。
 *  2. 短期内容指纹：适配器不返回 messageId 时，用进程级随机盐对文本做 HMAC，
 *     在极短窗口内比对同 group 内的回流文本。指纹只在内存中，不落盘、不打印。
 *  3. hop 预算：默认 maxHops=1，即"被本服务转发过的消息不再二次转发"。
 *     即使网关没有回显 messageId，指纹层也会在 20 秒窗口内拦住 1:1 回环。
 *
 * 隐私说明：内容指纹是对文本做的 keyed HMAC，盐每进程随机生成、进程退出即消失，
 * 不构成"持久化存储聊天内容"。即便如此，仓库不把它写进任何日志。
 */

import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "../types";

export interface LoopGuardOptions {
  enabled: boolean;
  echoTtlMs: number;
  fingerprintWindowMs: number;
  salt?: Buffer;
  now?: () => number;
}

interface EchoEntry {
  group: string;
  hop: number;
  expiresAt: number;
}

export type LoopLookup = { kind: "none" } | { kind: "echo"; group: string; hop: number };

const MAX_ENTRIES = 10_000;

export class LoopGuard {
  private readonly enabled: boolean;
  private readonly echoTtlMs: number;
  private readonly fingerprintWindowMs: number;
  private readonly salt: Buffer;
  private readonly now: () => number;

  private readonly echoes = new Map<string, EchoEntry>();
  private readonly fingerprints = new Map<string, number>();

  constructor(options: LoopGuardOptions) {
    this.enabled = options.enabled;
    this.echoTtlMs = options.echoTtlMs;
    this.fingerprintWindowMs = options.fingerprintWindowMs;
    this.salt = options.salt ?? randomBytes(32);
    this.now = options.now ?? (() => Date.now());
  }

  get active(): boolean {
    return this.enabled;
  }

  private echoKey(platform: string, conversationId: string, messageId: string): string {
    return `${platform}:${conversationId}:${messageId}`;
  }

  /** 发送成功后登记：目标侧这条 messageId 是本服务产生的。 */
  rememberEcho(platform: string, conversationId: string, messageId: string, group: string, hop: number): void {
    if (!this.enabled || !messageId) return;
    this.sweep();
    if (this.echoes.size >= MAX_ENTRIES) {
      const oldest = this.echoes.keys().next();
      if (!oldest.done) this.echoes.delete(oldest.value);
    }
    this.echoes.set(this.echoKey(platform, conversationId, messageId), {
      group,
      hop,
      expiresAt: this.now() + this.echoTtlMs,
    });
  }

  /** 判断入站消息是否是本服务自己发出的回显。 */
  lookupEcho(message: Pick<IncomingMessage, "platform" | "conversationId" | "messageId">): LoopLookup {
    if (!this.enabled) return { kind: "none" };
    const key = this.echoKey(message.platform, message.conversationId, message.messageId);
    const entry = this.echoes.get(key);
    if (!entry) return { kind: "none" };
    if (entry.expiresAt <= this.now()) {
      this.echoes.delete(key);
      return { kind: "none" };
    }
    return { kind: "echo", group: entry.group, hop: entry.hop };
  }

  /** 消费回显记录（当 hop 预算允许再转发一次时，避免同一条消息被反复计数）。 */
  consumeEcho(message: Pick<IncomingMessage, "platform" | "conversationId" | "messageId">): void {
    this.echoes.delete(this.echoKey(message.platform, message.conversationId, message.messageId));
  }

  /** 发送成功后登记出站文本指纹（仅内存）。 */
  rememberFingerprint(group: string, text: string): void {
    if (!this.enabled || this.fingerprintWindowMs <= 0) return;
    this.sweep();
    this.fingerprints.set(this.fingerprintOf(group, text), this.now() + this.fingerprintWindowMs);
  }

  /** 短期指纹回流判定：同 group 内窗口期内出现相同文本 ⇒ 疑似回环。 */
  isFingerprintLoop(group: string, message: Pick<IncomingMessage, "text">): boolean {
    if (!this.enabled || this.fingerprintWindowMs <= 0) return false;
    if (message.text === null) return false;
    const key = this.fingerprintOf(group, message.text);
    const expiresAt = this.fingerprints.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.fingerprints.delete(key);
      return false;
    }
    return true;
  }

  private fingerprintOf(group: string, text: string): string {
    const normalized = text.trim().replace(/[\s\u3000]+/gu, " ");
    return createHmac("sha256", this.salt).update(`${group}\u0000${normalized}`, "utf8").digest("hex").slice(0, 32);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.echoes) {
      if (entry.expiresAt <= now) this.echoes.delete(key);
    }
    for (const [key, expiresAt] of this.fingerprints) {
      if (expiresAt <= now) this.fingerprints.delete(key);
    }
  }

  /** 仅供测试观察。 */
  stats(): { echoes: number; fingerprints: number } {
    return { echoes: this.echoes.size, fingerprints: this.fingerprints.size };
  }
}
