/**
 * 【实验模式】回环防护：Web Crypto HMAC 内容指纹 + 回显 messageId。
 *
 * 与核心 `src/pipeline/loop-guard.ts` 同一思路，但为浏览器/WebView 重写：
 *  - 核心用 `node:crypto` 的 createHmac；浏览器没有，改用 `crypto.subtle`（HMAC-SHA256）；
 *  - 盐每实例随机（`crypto.getRandomValues`），只存在内存，停止即随实例丢弃；
 *  - **指纹表只存 HMAC 摘要与过期时间**，不存正文、不存明文、不落任何存储。
 *
 * 三层机制（从强到弱，与核心文档一致）：
 *  1. 回显 ID：自己发出的消息若被网关作为新入站消息回推，用 messageId 直接识别；
 *  2. 短期内容指纹：同 group 内窗口期出现相同文本 ⇒ 疑似回环（默认 20 秒）；
 *  3. hop 预算由上层保证：本模式只转发一次，不二次转发。
 *
 * 隐私说明：HMAC 是带密钥的摘要，且盐不落盘；本模块没有任何日志输出，
 * 摘要本身也不出现在 UI（只出现"已跳过：疑似回环"这类元数据）。
 */

export interface FingerprintGuardOptions {
  /** 测试可注入固定盐；生产不传，自动随机生成。 */
  salt?: Uint8Array;
  /** 回显 ID 记录有效期，默认 5 分钟。 */
  echoTtlMs?: number;
  /** 内容指纹窗口，默认 20 秒；0 表示关闭指纹层。 */
  fingerprintWindowMs?: number;
  /** 测试可注入时钟。 */
  now?: () => number;
  /** 内存上限，防止长时间运行无限增长。 */
  maxEntries?: number;
}

interface EchoEntry {
  expiresAt: number;
}

export interface EchoKeyParts {
  platform: string;
  conversationId: string;
  messageId: string;
}

const DEFAULT_ECHO_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FINGERPRINT_WINDOW_MS = 20 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;
/** 固定分组前缀，避免与其它字符串混用；不影响安全性（真正密钥是随机盐）。 */
const KEY_LABEL = "im-forwarder.b-mode.fingerprint";

function resolveCrypto(): Crypto {
  const value = (globalThis as { crypto?: Crypto }).crypto;
  if (!value || !value.subtle) {
    throw new Error("当前环境不支持 Web Crypto（HMAC 指纹防护不可用），实验模式无法启动");
  }
  return value;
}

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

function randomSalt(): Uint8Array {
  const salt = new Uint8Array(32);
  resolveCrypto().getRandomValues(salt);
  return salt;
}

function normalizeForFingerprint(text: string): string {
  return text.trim().replace(/[\s\u3000]+/gu, " ");
}

export class FingerprintGuard {
  private readonly salt: Uint8Array;
  private readonly echoTtlMs: number;
  private readonly fingerprintWindowMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  private readonly echoes = new Map<string, EchoEntry>();
  private readonly fingerprints = new Map<string, number>();
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(options: FingerprintGuardOptions = {}) {
    this.salt = options.salt ?? randomSalt();
    if (this.salt.length < 16) {
      throw new Error("指纹盐长度不足（至少 16 字节）");
    }
    this.echoTtlMs = options.echoTtlMs ?? DEFAULT_ECHO_TTL_MS;
    this.fingerprintWindowMs = options.fingerprintWindowMs ?? DEFAULT_FINGERPRINT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  // ─────────────── 第 1 层：回显 messageId ───────────────

  rememberEcho(parts: EchoKeyParts): void {
    if (parts.messageId.length === 0) return;
    this.sweep();
    this.echoes.set(this.echoKey(parts), { expiresAt: this.now() + this.echoTtlMs });
    this.trim(this.echoes);
  }

  lookupEcho(parts: EchoKeyParts): boolean {
    const key = this.echoKey(parts);
    const entry = this.echoes.get(key);
    if (entry === undefined) return false;
    if (entry.expiresAt <= this.now()) {
      this.echoes.delete(key);
      return false;
    }
    return true;
  }

  // ─────────────── 第 2 层：短期内容指纹 ───────────────

  /** 登记刚发出的文本（只登记摘要）。文本为空时忽略。 */
  async rememberFingerprint(group: string, text: string): Promise<void> {
    if (this.fingerprintWindowMs <= 0) return;
    const normalized = normalizeForFingerprint(text);
    if (normalized.length === 0) return;
    this.sweep();
    const key = await this.fingerprintOf(group, normalized);
    this.fingerprints.set(key, this.now() + this.fingerprintWindowMs);
    this.trim(this.fingerprints);
  }

  /** 判断入站文本是否命中窗口期内的指纹（疑似回环）。 */
  async isFingerprintLoop(group: string, text: string): Promise<boolean> {
    if (this.fingerprintWindowMs <= 0) return false;
    const normalized = normalizeForFingerprint(text);
    if (normalized.length === 0) return false;
    const key = await this.fingerprintOf(group, normalized);
    const expiresAt = this.fingerprints.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.fingerprints.delete(key);
      return false;
    }
    return true;
  }

  /** 停止时调用：清空回显表与指纹表（盐随实例一起被丢弃）。 */
  clear(): void {
    this.echoes.clear();
    this.fingerprints.clear();
    this.keyPromise = null;
  }

  /** 仅供测试与 UI 观察条目数量（不含任何内容）。 */
  stats(): { echoes: number; fingerprints: number } {
    return { echoes: this.echoes.size, fingerprints: this.fingerprints.size };
  }

  private async fingerprintOf(group: string, normalizedText: string): Promise<string> {
    const key = await this.importKey();
    const data = new TextEncoder().encode(`${group}\u0000${normalizedText}`);
    const signature = await resolveCrypto().subtle.sign("HMAC", key, data);
    return toHex(new Uint8Array(signature)).slice(0, 32);
  }

  private importKey(): Promise<CryptoKey> {
    if (this.keyPromise === null) {
      const subtle = resolveCrypto().subtle;
      const raw = new Uint8Array(this.salt);
      this.keyPromise = subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    }
    return this.keyPromise;
  }

  private echoKey(parts: EchoKeyParts): string {
    return `${parts.platform}:${parts.conversationId}:${parts.messageId}`;
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

  private trim(map: Map<string, unknown>): void {
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done === true) return;
      map.delete(oldest.value);
    }
  }
}

/** 仅暴露给测试的常量，便于断言默认窗口。 */
export const FINGERPRINT_DEFAULTS = {
  echoTtlMs: DEFAULT_ECHO_TTL_MS,
  fingerprintWindowMs: DEFAULT_FINGERPRINT_WINDOW_MS,
  keyLabel: KEY_LABEL,
} as const;
