/**
 * 伴生 API 的鉴权基础设施：配对码、长期令牌、恒定时间比较、失败限流。
 *
 * 设计取舍：
 *  · 配对码只在内存中存在（10 分钟、一次性）；不写盘、不进日志、不进 URL。
 *  · 长期令牌用 crypto.randomBytes 生成；比较时先 SHA-256 再 timingSafeEqual，
 *    这样比较耗时与令牌长度无关（避免长度侧信道），也不会因长度不等提前返回。
 *  · 限流按 IP 计数失败次数，5 次/分钟；成功后清零。
 *  · 本文件不依赖 Electron，因此可在纯 Node 环境（CI/self-test）独立运行。
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface Pairing {
  code: string;
  expiresAt: number;
}

/** 6 位数字配对码（000000–999999），用于桌面 UI 展示与手机端输入。 */
export function generatePairCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** 长期令牌：32 字节随机数的 base64url 表示（43 字符，无填充）。 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 恒定时间字符串比较：先做 SHA-256，长度恒为 32 字节。 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/** 配对码管理器：同一时刻只有一个有效配对码；兑换即作废（一次性）。 */
export class PairingManager {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private current: Pairing | null = null;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? PAIR_CODE_TTL_MS;
  }

  /** 生成（或复用未过期）的配对码。桌面 UI 反复打开时不应把旧码作废。 */
  issue(): Pairing {
    const existing = this.currentCode();
    if (existing) return existing;
    this.current = {
      code: generatePairCode(),
      expiresAt: this.now() + this.ttlMs,
    };
    return { ...this.current };
  }

  /** 强制轮换配对码（UI 上的"换一个配对码"）。 */
  rotate(): Pairing {
    this.current = null;
    return this.issue();
  }

  /** 当前有效配对码；过期返回 null（不自动生成）。 */
  currentCode(): Pairing | null {
    if (!this.current) return null;
    if (this.current.expiresAt <= this.now()) {
      this.current = null;
      return null;
    }
    return { ...this.current };
  }

  /** 兑换配对码：校验通过则立即作废（一次性），返回是否成功。 */
  redeem(code: string): boolean {
    const current = this.currentCode();
    if (!current) return false;
    if (!/^\d{6}$/u.test(code)) return false;
    if (!timingSafeEqualString(code, current.code)) return false;
    this.current = null;
    return true;
  }
}

/** 固定窗口失败限流（5 次/分钟/IP）。 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();

  constructor(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** 该 key 是否已被限流（达到上限）。 */
  blocked(key: string): boolean {
    const list = this.prune(key);
    return list.length >= this.limit;
  }

  /** 记录一次失败。 */
  recordFailure(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.failures.set(key, list);
  }

  /** 成功时清零该 key 的失败计数。 */
  reset(key: string): void {
    this.failures.delete(key);
  }

  private prune(key: string): number[] {
    const now = this.now();
    const list = (this.failures.get(key) ?? []).filter((timestamp) => now - timestamp < this.windowMs);
    if (list.length === 0) {
      this.failures.delete(key);
    } else {
      this.failures.set(key, list);
    }
    return list;
  }
}

/** 伴生长令牌的存储契约（主进程实现为 safeStorage 加密文件；测试实现为内存）。 */
export interface CompanionTokenStore {
  get(): { token: string; expiresAt: number } | null;
  issue(): { token: string; expiresAt: number };
}

/** 纯内存实现（用于独立 smoke 与不可加密平台上的临时令牌）。 */
export class InMemoryTokenStore implements CompanionTokenStore {
  private current: { token: string; expiresAt: number } | null = null;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number; token?: string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? TOKEN_TTL_MS;
    if (options.token) {
      this.current = { token: options.token, expiresAt: this.now() + this.ttlMs };
    }
  }

  get(): { token: string; expiresAt: number } | null {
    if (!this.current) return null;
    if (this.current.expiresAt <= this.now()) {
      this.current = null;
      return null;
    }
    return { ...this.current };
  }

  issue(): { token: string; expiresAt: number } {
    this.current = { token: generateToken(), expiresAt: this.now() + this.ttlMs };
    return { ...this.current };
  }
}
