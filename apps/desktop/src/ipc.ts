/**
 * 主进程 ↔ 渲染进程 ↔ 伴生 API 的消息/数据契约。
 *
 * 三条不可违反的约束（与 COMPLIANCE.md 及桌面端 README 一致）：
 *
 *  1. 本文件里的任何类型都不得携带消息正文、会话 ID、接收方告知要素原文。
 *     `LogRecord` 只保留 9 个白名单字段；`RouteSummary` 刻意去掉 conversationId 与 receiver。
 *  2. 令牌（EasyBot token / 伴生 API token）永不进入渲染进程：渲染进程只拿到
 *     `TokenStatus.saved` 这类布尔与来源标记。真实令牌只存在于主进程与子进程环境变量中。
 *  3. 日志只存在于主进程内存环形缓冲（最多 1000 条），不落盘；
 *     伴生 API 的 /api/logs 与渲染进程看到的是同一份白名单记录。
 */

/** 日志面板允许出现的字段（白名单）。与需求书逐字一致，多一个字段都不行。 */
export const LOG_FIELD_WHITELIST = [
  "ts",
  "level",
  "event",
  "routeId",
  "sourcePlatform",
  "targetPlatform",
  "status",
  "errorCode",
  "latencyMs",
] as const;

export type LogField = (typeof LOG_FIELD_WHITELIST)[number];

export type LogLevelName = "debug" | "info" | "warn" | "error";

/** 一条已经过白名单过滤的日志记录（不含正文，可安全进内存/UI/伴生 API）。 */
export interface LogRecord {
  ts: string;
  level: LogLevelName;
  event: string;
  routeId?: string;
  sourcePlatform?: string;
  targetPlatform?: string;
  status?: string;
  errorCode?: string;
  latencyMs?: number;
}

export interface ForwardCounts {
  forwarded: number;
  failed: number;
  skipped: number;
}

/** 运行状态快照（桌面 UI 与 GET /api/status 共用）。 */
export interface StatusSnapshot {
  running: boolean;
  /** 核心进程报告的运行起始时间（ms epoch）；未运行为 null。 */
  startedAt: number | null;
  routeCount: number;
  gateway: { baseUrlHost: string };
  /** Telegram 出境闸门是否完全打开（五要素齐备）。 */
  crossBorderOpen: boolean;
  counts: ForwardCounts;
}

/** 合规/配置违规项：只保留 code + message（+ 整改建议），绝不带正文。 */
export interface Violation {
  code: string;
  message: string;
  hint?: string;
  routeId?: string;
}

export interface ConfigState {
  /** 配置文件绝对路径（desktop userData/config.yaml 或 IM_CONFIG_PATH）。 */
  path: string;
  /** YAML 原文（配置本身不含任何令牌；允许编辑）。 */
  content: string;
  exists: boolean;
  /** 内置示例配置是否可用（用于"恢复示例"）。 */
  exampleAvailable: boolean;
  /** 读取失败原因（例如安装包资源缺失）。 */
  error?: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

export interface SaveResult extends ValidationResult {
  saved: boolean;
  /** 校验通过并保存后，配置文件中路由数量（供 UI 展示）。 */
  routeCount: number;
}

export interface TokenStatus {
  /** 是否已配置 EasyBot 网关令牌（true/false）。 */
  saved: boolean;
  /** 令牌来源：safeStorage 加密文件 / 环境变量 / 未配置。 */
  source: "safeStorage" | "env" | "none";
  /** 当前环境是否支持 safeStorage 加密（false 时禁止落盘保存令牌）。 */
  encryptionAvailable: boolean;
  /** 只展示环境变量名，绝不展示令牌本身。 */
  tokenEnv: string;
  /** 保存失败等错误文案（不含令牌）。 */
  error?: string;
}

export interface CompanionState {
  running: boolean;
  host: string;
  port: number;
  lanMode: boolean;
  /** 桌面 UI 展示的访问地址（局域网模式下为 0.0.0.0 提示 + 本机 IP 候选）。 */
  address: string;
  /** 6 位一次性配对码（10 分钟有效）；未运行时为 null。 */
  pairCode: string | null;
  pairCodeExpiresAt: number | null;
  /** 伴生长令牌过期时间（ms epoch）。 */
  tokenExpiresAt: number | null;
  /** 静态资源（companion-web/dist）是否可用；不可用时服务返回 503 而不是崩溃。 */
  staticAvailable: boolean;
  /** 伴生令牌是否可持久化（safeStorage 不可用时退化为每次启动重新配对）。 */
  credentialsPersistent: boolean;
  /** 局域网模式警告文案（普通模式为 null）。 */
  warning: string | null;
  /** 启动失败原因（端口占用等），null 表示无错误。 */
  error: string | null;
}

export interface ControlResult {
  ok: boolean;
  running: boolean;
  violations?: Violation[];
}

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  configPath: string;
  homepage: string;
  issuesUrl: string;
  license: string;
  /** 未签名的构建：不提供自动更新与遥测。 */
  signed: boolean;
  autoUpdate: false;
}

/** IPC 通道名（主进程与 preload 共用；渲染进程通过 preload 白名单函数访问）。 */
export const IPC = {
  statusGet: "desktop:status:get",
  statusChanged: "desktop:status:changed",
  configRead: "desktop:config:read",
  configExample: "desktop:config:example",
  configValidate: "desktop:config:validate",
  configSave: "desktop:config:save",
  tokenStatus: "desktop:token:status",
  tokenSet: "desktop:token:set",
  tokenClear: "desktop:token:clear",
  coreStart: "desktop:core:start",
  coreStop: "desktop:core:stop",
  companionState: "desktop:companion:state",
  companionLanMode: "desktop:companion:lan-mode",
  companionPort: "desktop:companion:port",
  companionNewPairCode: "desktop:companion:new-pair-code",
  companionChanged: "desktop:companion:changed",
  logsList: "desktop:logs:list",
  logNew: "desktop:logs:new",
  appInfo: "desktop:app:info",
  openExternal: "desktop:app:open-external",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

const LOG_LEVELS: readonly LogLevelName[] = ["debug", "info", "warn", "error"];
const MAX_FIELD_LENGTH = 120;

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (cleaned.length === 0) return undefined;
  if (cleaned.length > MAX_FIELD_LENGTH) {
    return `[omitted:${cleaned.length}]`;
  }
  return cleaned;
}

/**
 * 日志白名单投影（主进程与伴生 API 共用）。
 *
 * 输入可以是核心 Logger 产出的 JSON、子进程 message 或任何不可信对象；
 * 只有 9 个白名单字段会被保留，其余一律丢弃。字符串做控制字符清理与超长占位，
 * 数字必须是有限值。返回值不含任何可能导致正文泄漏的字段。
 */
export function sanitizeLogRecord(raw: unknown): LogRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const level = typeof source["level"] === "string" ? source["level"] : undefined;
  if (!level || !LOG_LEVELS.includes(level as LogLevelName)) return null;

  const ts = cleanString(source["ts"]) ?? new Date().toISOString();
  const event = cleanString(source["event"]);
  if (!event) return null;

  const record: LogRecord = { ts, level: level as LogLevelName, event };

  const routeId = cleanString(source["routeId"]);
  if (routeId) record.routeId = routeId;
  const sourcePlatform = cleanString(source["sourcePlatform"]);
  if (sourcePlatform) record.sourcePlatform = sourcePlatform;
  const targetPlatform = cleanString(source["targetPlatform"]);
  if (targetPlatform) record.targetPlatform = targetPlatform;
  const status = cleanString(source["status"]);
  if (status) record.status = status;
  const errorCode = cleanString(source["errorCode"]);
  if (errorCode) record.errorCode = errorCode;

  const latencyMs = source["latencyMs"];
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
    record.latencyMs = Math.max(0, Math.round(latencyMs));
  }

  return record;
}

/**
 * preload 通过 contextBridge 暴露给渲染进程的唯一 API 面。
 * 渲染进程无法访问 ipcRenderer / require / process / 文件系统。
 */
export interface DesktopApi {
  getStatus(): Promise<StatusSnapshot>;
  getConfig(): Promise<ConfigState>;
  getExampleConfig(): Promise<string>;
  validateConfig(yaml: string): Promise<ValidationResult>;
  saveConfig(yaml: string): Promise<SaveResult>;
  getTokenStatus(): Promise<TokenStatus>;
  setToken(token: string): Promise<TokenStatus>;
  clearToken(): Promise<TokenStatus>;
  start(): Promise<ControlResult>;
  stop(): Promise<ControlResult>;
  getCompanionState(): Promise<CompanionState>;
  setLanMode(enabled: boolean, acknowledged: boolean): Promise<CompanionState>;
  setCompanionPort(port: number): Promise<CompanionState>;
  newPairCode(): Promise<CompanionState>;
  getLogs(limit?: number): Promise<LogRecord[]>;
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): Promise<boolean>;
  onStatus(callback: (status: StatusSnapshot) => void): () => void;
  onLog(callback: (record: LogRecord) => void): () => void;
  onCompanion(callback: (state: CompanionState) => void): () => void;
}
