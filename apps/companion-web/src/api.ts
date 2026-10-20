/**
 * 桌面端「伴生 HTTP API」客户端。
 *
 * 契约（0.2.0，严格按桌面端文档调用）：
 *   GET  /api/health                        → {ok, app, version}
 *   POST /api/pair {code}                    → {token, expiresAt}
 *   GET  /api/status                        需 Bearer → {running, startedAt, routeCount, gateway:{baseUrlHost}, crossBorderOpen, counts}
 *   POST /api/control {action:"start"|"stop"} 需 Bearer → {running}（409 时带 violations）
 *   GET  /api/routes                        需 Bearer → 脱敏路由
 *   GET  /api/logs?limit=100                需 Bearer → 白名单字段数组
 *
 * 本模块的两个安全边界：
 *  1. 令牌只放在 `Authorization: Bearer` 请求头里，不进 URL、不进日志、不落盘；
 *  2. 所有远端返回都被当作不可信数据做形状校验与白名单投影：
 *     日志只保留白名单字段，路由只保留脱敏字段（即使桌面端误发了 conversationId 也不显示）。
 */

/** 平台与会话类型的展示映射（未知值一律显示为"未知"）。 */
const PLATFORM_LABELS: Record<string, string> = {
  wechat: "微信",
  qq: "QQ",
  telegram: "Telegram",
};

const CHAT_TYPE_LABELS: Record<string, string> = {
  private: "私聊",
  group: "群聊",
};

export function platformLabel(value: unknown): string {
  return typeof value === "string" ? (PLATFORM_LABELS[value] ?? "未知平台") : "未知平台";
}

export function chatTypeLabel(value: unknown): string {
  return typeof value === "string" ? (CHAT_TYPE_LABELS[value] ?? "未知类型") : "未知类型";
}

/** 日志字段白名单（与核心 logger 的 LOG_FIELD_WHITELIST 对齐）。 */
export const LOG_FIELD_WHITELIST = [
  "ts",
  "level",
  "event",
  "routeId",
  "sourcePlatform",
  "targetPlatform",
  "status",
  "kind",
  "scope",
  "errorCode",
  "latencyMs",
  "count",
  "attempt",
  "host",
] as const;

export type LogFieldName = (typeof LOG_FIELD_WHITELIST)[number];
export type LogValue = string | number | boolean;
export type LogRow = Partial<Record<LogFieldName, LogValue>>;

const MAX_LOG_STRING = 120;

/**
 * 白名单投影 + 值清洗。
 * 字符串去控制字符；超长直接替换为 `[omitted:n]`（绝不保留前 N 个字符，防止正文片段泄漏）。
 */
export function pickLogFields(raw: unknown): LogRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const row: LogRow = {};
  for (const key of LOG_FIELD_WHITELIST) {
    const value = source[key];
    if (typeof value === "number") {
      if (Number.isFinite(value)) row[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      row[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
      if (cleaned.length === 0) continue;
      row[key] = cleaned.length > MAX_LOG_STRING ? `[omitted:${cleaned.length}]` : cleaned;
    }
    // 对象/数组/其它类型一律丢弃。
  }
  return row;
}

export type ApiErrorKind =
  | "unauthorized"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "bad_response"
  | "http";

export interface CompanionApiErrorInit {
  kind: ApiErrorKind;
  message: string;
  status: number | null;
  violations?: string[];
  retryAfterSeconds?: number | null;
}

/** 归一化错误：调用方只依赖 kind + 中文 message，不需要认识 HTTP 细节。 */
export class CompanionApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly violations: string[];
  readonly retryAfterSeconds: number | null;

  constructor(init: CompanionApiErrorInit) {
    super(init.message);
    this.name = "CompanionApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.violations = init.violations ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

export interface HealthInfo {
  ok: boolean;
  app: string;
  version: string;
}

export interface StatusCounts {
  forwarded: number;
  failed: number;
  skipped: number;
}

export interface StatusInfo {
  running: boolean;
  startedAt: string | null;
  routeCount: number;
  gatewayHost: string;
  crossBorderOpen: boolean;
  counts: StatusCounts;
}

export interface RouteView {
  id: string;
  group: string;
  contentOwner: string;
  from: string;
  to: string[];
}

export interface PairResult {
  token: string;
  expiresAt: string | null;
}

export interface ControlResult {
  running: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CompanionApiOptions {
  /** 便于测试注入；默认使用全局 fetch。 */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function badResponse(detail: string): CompanionApiError {
  return new CompanionApiError({
    kind: "bad_response",
    status: null,
    message: `桌面端返回了无法识别的内容（${detail}）。请确认桌面端版本不低于 0.2.0。`,
  });
}

/** 把 409 响应体里的 violations 转成可展示的字符串数组（仅字符串，长度受限）。 */
function readViolations(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const raw = body["violations"];
  if (!Array.isArray(raw)) return [];
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      list.push(item.length > 200 ? `${item.slice(0, 200)}…` : item);
    }
  }
  return list;
}

export class CompanionApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token: string, options: CompanionApiOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** 健康检查（无需令牌）。也用于"连接前先探活"。 */
  async health(): Promise<HealthInfo> {
    const body = await this.request("/api/health", { method: "GET" }, { authenticated: false });
    if (!isRecord(body) || typeof body["ok"] !== "boolean") {
      throw badResponse("health 缺少 ok");
    }
    return {
      ok: body["ok"] as boolean,
      app: readString(body, "app") ?? "im-forwarder",
      version: readString(body, "version") ?? "未知版本",
    };
  }

  /** 6 位配对码换令牌（无需令牌）。 */
  async pair(code: string): Promise<PairResult> {
    const trimmed = code.trim();
    if (!/^\d{6}$/u.test(trimmed)) {
      throw new CompanionApiError({
        kind: "bad_response",
        status: null,
        message: "配对码必须是 6 位数字，请在桌面端「移动端配对」里查看。",
      });
    }
    const body = await this.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: trimmed }),
    }, { authenticated: false });

    if (!isRecord(body)) throw badResponse("pair 响应不是对象");
    const token = readString(body, "token");
    if (token === null || token.trim().length === 0) throw badResponse("pair 响应缺少 token");
    return { token, expiresAt: readString(body, "expiresAt") };
  }

  async status(): Promise<StatusInfo> {
    const body = await this.request("/api/status", { method: "GET" }, { authenticated: true });
    if (!isRecord(body)) throw badResponse("status 响应不是对象");

    const running = readBoolean(body, "running");
    if (running === null) throw badResponse("status 缺少 running");

    const countsRaw = body["counts"];
    const counts: StatusCounts = { forwarded: 0, failed: 0, skipped: 0 };
    if (isRecord(countsRaw)) {
      counts.forwarded = readNumber(countsRaw, "forwarded") ?? 0;
      counts.failed = readNumber(countsRaw, "failed") ?? 0;
      counts.skipped = readNumber(countsRaw, "skipped") ?? 0;
    }

    const gatewayRaw = body["gateway"];
    const gatewayHost = isRecord(gatewayRaw) ? (readString(gatewayRaw, "baseUrlHost") ?? "未知") : "未知";

    return {
      running,
      startedAt: readString(body, "startedAt"),
      routeCount: readNumber(body, "routeCount") ?? 0,
      gatewayHost,
      crossBorderOpen: readBoolean(body, "crossBorderOpen") ?? false,
      counts,
    };
  }

  /** 预检失败时抛 conflict（含 violations）。 */
  async control(action: "start" | "stop"): Promise<ControlResult> {
    const body = await this.request("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }, { authenticated: true });

    if (!isRecord(body)) throw badResponse("control 响应不是对象");
    const running = readBoolean(body, "running");
    if (running === null) throw badResponse("control 缺少 running");
    return { running };
  }

  async routes(): Promise<RouteView[]> {
    const body = await this.request("/api/routes", { method: "GET" }, { authenticated: true });
    if (!Array.isArray(body)) throw badResponse("routes 响应不是数组");

    const views: RouteView[] = [];
    for (const item of body) {
      if (!isRecord(item)) continue;
      const from = item["from"];
      const to = item["to"];
      if (!isRecord(from) || !Array.isArray(to)) continue;

      const targets: string[] = [];
      for (const target of to) {
        if (!isRecord(target)) continue;
        targets.push(`${platformLabel(target["platform"])} · ${chatTypeLabel(target["chatType"])}`);
      }
      if (targets.length === 0) continue;

      views.push({
        id: readString(item, "id") ?? "（无 id）",
        group: readString(item, "group") ?? "（无 group）",
        contentOwner: readString(item, "contentOwner") ?? "未知",
        from: `${platformLabel(from["platform"])} · ${chatTypeLabel(from["chatType"])}`,
        to: targets,
      });
    }
    return views;
  }

  /** 只保留白名单字段；服务端即使多发了正文相关字段也不会进入 UI。 */
  async logs(limit = 100): Promise<LogRow[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const body = await this.request(`/api/logs?limit=${safeLimit}`, { method: "GET" }, { authenticated: true });
    if (!Array.isArray(body)) throw badResponse("logs 响应不是数组");
    const rows: LogRow[] = [];
    for (const item of body) {
      // 服务端可能把整条记录包在字段里；这里只接受对象并做白名单投影。
      const row = pickLogFields(item);
      if (Object.keys(row).length > 0) rows.push(row);
    }
    return rows;
  }

  private async request(
    path: string,
    init: RequestInit,
    options: { authenticated: boolean },
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (options.authenticated) {
      if (this.token.trim().length === 0) {
        throw new CompanionApiError({
          kind: "unauthorized",
          status: 401,
          message: "尚未配对：请先在「连接」页输入桌面端显示的 6 位配对码。",
        });
      }
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    // 超时：单独 AbortController，避免把令牌/正文写进任何日志。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
    } catch {
      throw new CompanionApiError({
        kind: "network",
        status: null,
        message:
          "无法连接桌面端。请依次检查：① 手机与电脑是否在同一局域网；" +
          "② 桌面端是否已打开「局域网访问 / 伴生服务」开关；③ 电脑防火墙是否放行该端口。",
      });
    } finally {
      clearTimeout(timer);
    }

    const retryAfter = this.readRetryAfter(response);

    if (!response.ok) {
      throw await this.mapHttpError(response, retryAfter);
    }

    // 204 之类的空响应按"无内容"处理；其它情况必须能解析成 JSON。
    if (response.status === 204) return null;
    try {
      return (await response.json()) as unknown;
    } catch {
      throw badResponse(`HTTP ${response.status} 响应不是合法 JSON`);
    }
  }

  private readRetryAfter(response: Response): number | null {
    const raw = response.headers.get("Retry-After");
    if (raw === null) return null;
    const seconds = Number.parseInt(raw, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  private async mapHttpError(response: Response, retryAfterSeconds: number | null): Promise<CompanionApiError> {
    let body: unknown = null;
    try {
      body = (await response.json()) as unknown;
    } catch {
      body = null;
    }
    const violations = readViolations(body);

    if (response.status === 401) {
      return new CompanionApiError({
        kind: "unauthorized",
        status: 401,
        message:
          "配对令牌无效或已过期。请回到「连接」页，用桌面端新生成的 6 位配对码重新配对" +
          "（令牌只保存在内存，刷新页面后必须重输）。",
      });
    }
    if (response.status === 409) {
      return new CompanionApiError({
        kind: "conflict",
        status: 409,
        message: violations.length > 0
          ? "转发预检未通过，已拒绝启动。请按下面各项修正桌面端配置后重试："
          : "转发预检未通过，已拒绝启动。请检查桌面端路由与合规配置后重试。",
        violations,
      });
    }
    if (response.status === 429) {
      return new CompanionApiError({
        kind: "rate_limited",
        status: 429,
        retryAfterSeconds,
        message:
          retryAfterSeconds === null
            ? "请求过于频繁，请稍后再试。"
            : `请求过于频繁，请 ${retryAfterSeconds} 秒后重试。`,
      });
    }
    if (response.status === 503) {
      return new CompanionApiError({
        kind: "unavailable",
        status: 503,
        message: "桌面端伴生 API 暂时不可用（可能正在启动或配对通道未开启），请稍后重试。",
      });
    }
    return new CompanionApiError({
      kind: "http",
      status: response.status,
      message: `桌面端返回 HTTP ${response.status}，请查看桌面端日志。`,
    });
  }
}
