/**
 * 连接配置存储：**host 可持久化，token 绝不落盘**。
 *
 * 合规红线（任务书第 3 条）：
 *  - 网关/桌面端令牌只允许存在于内存；刷新页面、重启应用都必须重新配对/重输；
 *  - 不得写入 localStorage / sessionStorage / IndexedDB / URL / 日志。
 *
 * 本模块是这条红线唯一允许接触 localStorage 的地方：
 *  - 只写 `host`（桌面伴生 API 的地址，属于网络配置而非凭据）；
 *  - `setToken()` 只改内存字段，**没有任何代码路径把 token 传给 storage**；
 *    这一点由 test/store.spec.ts 用"记录全部写操作的假 storage"做回归验证。
 */

/** 只依赖 Storage 的读取三件套，方便测试注入假实现。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage 的键名。刻意只存地址，不含令牌。 */
export const HOST_STORAGE_KEY = "im-forwarder.companion.host";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface NormalizedHost {
  host: string;
}

export interface HostError {
  error: string;
}

/**
 * 归一化桌面伴生 API 地址。
 *
 * 允许用户只填 `192.168.1.8:3210`（自动补 http://），也允许带子路径。
 * 拒绝：非 http(s) 协议、带用户名/密码的 URL、空主机名 ——
 * 把"地址里夹带凭据"这类做法挡在入口处。
 */
export function normalizeHost(input: string): NormalizedHost | HostError {
  const raw = input.trim();
  if (raw.length === 0) {
    return { error: "请填写桌面端伴生服务地址，例如 http://192.168.1.8:3210" };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "地址格式不正确，示例：http://192.168.1.8:3210" };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { error: "只允许 http:// 或 https:// 地址" };
  }
  if (url.username !== "" || url.password !== "") {
    return { error: "地址中不能包含用户名或密码" };
  }
  if (url.hostname === "") {
    return { error: "地址缺少主机名" };
  }

  // 去掉查询串与片段：地址只表示"服务在哪里"，不允许夹带参数（令牌可能被误塞进 URL）。
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/u, "");
  return { host: `${url.protocol}//${url.host}${path}` };
}

export interface ConnectionConfig {
  /** 桌面伴生 API 基地址（可持久化） */
  host: string;
  /** 配对令牌（仅内存，null 表示未配对） */
  token: string | null;
  /** 令牌过期时间（仅内存展示用） */
  tokenExpiresAt: string | null;
}

export interface CompanionStoreOptions {
  /** 不传则使用浏览器 localStorage；传 null 表示禁用持久化（内存模式）。 */
  storage?: StorageLike | null;
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof globalThis.localStorage === "undefined") return null;
    return globalThis.localStorage;
  } catch {
    // 隐私模式 / 被策略禁用时 localStorage 访问会抛异常。
    return null;
  }
}

export class CompanionStore {
  private readonly storage: StorageLike | null;
  private config: ConnectionConfig;

  constructor(options: CompanionStoreOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.config = {
      host: this.readPersistedHost(),
      token: null,
      tokenExpiresAt: null,
    };
  }

  get connection(): ConnectionConfig {
    return { ...this.config };
  }

  get host(): string {
    return this.config.host;
  }

  get token(): string | null {
    return this.config.token;
  }

  get paired(): boolean {
    return this.config.token !== null;
  }

  /** 校验并保存 host（持久化）。返回归一化后的地址或错误。 */
  setHost(input: string): NormalizedHost | HostError {
    const normalized = normalizeHost(input);
    if ("error" in normalized) return normalized;
    this.config.host = normalized.host;
    try {
      this.storage?.setItem(HOST_STORAGE_KEY, normalized.host);
    } catch {
      // 存储不可用不影响本次会话使用，只是刷新后需要重填地址。
    }
    return normalized;
  }

  /**
   * 保存配对令牌。**只写内存。**
   * 这里刻意不接受"记住我"之类的参数：不存在持久化分支。
   */
  setToken(token: string, expiresAt: string | null): void {
    if (token.trim().length === 0) {
      throw new Error("令牌不能为空");
    }
    this.config.token = token;
    this.config.tokenExpiresAt = expiresAt;
  }

  /** 丢弃内存令牌（断开连接 / 401 / 停止实验模式）。 */
  clearToken(): void {
    this.config.token = null;
    this.config.tokenExpiresAt = null;
  }

  /** 清空全部会话状态；host 是否保留由调用方决定。 */
  clearAll(options: { keepHost: boolean } = { keepHost: true }): void {
    this.clearToken();
    if (!options.keepHost) {
      this.config.host = "";
      try {
        this.storage?.removeItem(HOST_STORAGE_KEY);
      } catch {
        // 忽略存储失败。
      }
    }
  }

  private readPersistedHost(): string {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(HOST_STORAGE_KEY) ?? null;
    } catch {
      return "";
    }
    if (raw === null) return "";
    // 旧版本/被手工改坏的值：重新校验一遍，非法就当没存过。
    const normalized = normalizeHost(raw);
    return "error" in normalized ? "" : normalized.host;
  }
}
