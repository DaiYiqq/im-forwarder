/**
 * 同意记录的本地存储。
 *
 * 重要边界（对应需求第 8 条）：
 *   这里**只**保存"谁在什么时候、针对哪个版本的风险告知、同意了哪种范围"。
 *   不保存聊天正文、不保存消息 ID、不保存转发过的内容。
 *   文件内容是典型的"同意证明元数据"，其本身不含个人信息内容，
 *   但包含会话标识（属于个人信息），因此 data/ 目录被 .gitignore 排除。
 *
 * 损坏处理：读取失败 / JSON 结构非法一律抛错（fail-closed）。
 * 宁可启动失败，也不要在"不知道谁同意过"的状态下开始转发。
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Platform } from "../types";

export type ConsentScope = "domestic" | "cross-border";

export interface ConsentGrant {
  /** 该同意针对的风险告知文案版本 */
  noticeVersion: string;
  grantedAt: string;
  expiresAt: string;
  /**
   * 该同意覆盖的路由 id 列表（链路粒度）。
   *
   * 为什么需要：同一会话可能配置了多条 third-party 路由（例如同时转发到 QQ 与 Telegram），
   * 而告知文案会列出具体的接收方。若同意只在"会话"维度生效，一次同意就会同时授权
   * 用户没有逐条确认过的其它接收方，属于对"单独同意"的过度解释。
   *
   * 兼容性：旧版记录没有该字段时，视为"对该会话的全部他人内容路由生效"
   * （load 时不做改写，读取时按 legacy 处理）。
   */
  routes?: string[];
}

export interface ConsentRecord {
  scopeKey: string;
  platform: Platform;
  conversationId: string;
  grants: Partial<Record<ConsentScope, ConsentGrant>>;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  records: Record<string, ConsentRecord>;
}

export class ConsentStoreError extends Error {
  readonly code = "CONSENT_STORE_CORRUPT";

  constructor(message: string) {
    super(message);
    this.name = "ConsentStoreError";
  }
}

function emptyStore(): StoreFile {
  return { version: 1, records: {} };
}

export class ConsentStore {
  private readonly filePath: string | null;
  private readonly now: () => number;
  private data: StoreFile = emptyStore();

  private constructor(filePath: string | null, now: () => number) {
    this.filePath = filePath;
    this.now = now;
  }

  static inMemory(now: () => number = () => Date.now()): ConsentStore {
    return new ConsentStore(null, now);
  }

  static fromFile(filePath: string, now: () => number = () => Date.now()): ConsentStore {
    const store = new ConsentStore(filePath, now);
    store.load();
    return store;
  }

  get persistent(): boolean {
    return this.filePath !== null;
  }

  load(): void {
    if (!this.filePath || !existsSync(this.filePath)) {
      this.data = emptyStore();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new ConsentStoreError(
        `同意记录文件无法解析，拒绝在状态不明的情况下启动：${this.filePath}（${String((error as Error).message)}）`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConsentStoreError(`同意记录文件结构非法：${this.filePath}`);
    }
    const candidate = parsed as Partial<StoreFile>;
    if (candidate.version !== 1 || typeof candidate.records !== "object" || candidate.records === null) {
      throw new ConsentStoreError(`同意记录文件版本/结构不受支持：${this.filePath}`);
    }
    for (const [key, record] of Object.entries(candidate.records)) {
      if (!record || typeof record !== "object" || record.scopeKey !== key) {
        throw new ConsentStoreError(`同意记录条目非法：${key}`);
      }
    }
    this.data = { version: 1, records: candidate.records as Record<string, ConsentRecord> };
  }

  get(scopeKey: string): ConsentRecord | undefined {
    return this.data.records[scopeKey];
  }

  upsert(record: ConsentRecord): void {
    this.data.records[record.scopeKey] = record;
    this.flush();
  }

  remove(scopeKey: string): boolean {
    if (!(scopeKey in this.data.records)) return false;
    delete this.data.records[scopeKey];
    this.flush();
    return true;
  }

  size(): number {
    return Object.keys(this.data.records).length;
  }

  snapshot(): StoreFile {
    return JSON.parse(JSON.stringify(this.data)) as StoreFile;
  }

  /** 原子写入：先写临时文件再 rename，避免进程被杀时留下半截 JSON。 */
  private flush(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    renameSync(tmp, this.filePath);
  }

  static assertWritableDirectory(directory: string): void {
    mkdirSync(directory, { recursive: true });
    accessSync(directory, constants.W_OK);
  }

  /** 便于测试注入时间。 */
  nowMs(): number {
    return this.now();
  }
}
