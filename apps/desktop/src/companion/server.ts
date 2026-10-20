/**
 * 移动伴生控制 API（手机 PWA / APK 用）。
 *
 * 契约（与手机端同事对齐，改动必须同步）：
 *   · 默认 127.0.0.1:17871；局域网模式由桌面 UI 显式开启（0.0.0.0:17871）并显示警告。
 *   · 静态资源：同端口 / 提供 companion-web 构建产物；缺失时 503 + 明确提示，不崩溃。
 *   · 鉴权：除 POST /api/pair 外，所有 /api/* 必须 `Authorization: Bearer <token>`，否则 401。
 *   · CORS：仅 http(s)://localhost、http(s)://127.0.0.1（任意端口）与 capacitor://localhost；
 *     预检只允许 GET/POST + Authorization/Content-Type。
 *   · 请求体上限 16KB；所有响应 Cache-Control: no-store；错误响应绝不反射请求体。
 *   · 只返回脱敏数据：不含消息正文、会话 ID、接收方告知要素、原始报文、令牌。
 *
 * 本文件不 import electron，可被 `node dist/companion-server.cjs` 独立启动做无界面自测。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type {
  CompanionState,
  ControlResult,
  LogRecord,
  StatusSnapshot,
  Violation,
} from "../ipc";
import { sanitizeLogRecord } from "../ipc";
import {
  InMemoryTokenStore,
  PairingManager,
  RateLimiter,
  timingSafeEqualString,
  TOKEN_TTL_MS,
  type CompanionTokenStore,
} from "./auth";

export const DEFAULT_COMPANION_PORT = 17871;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_LOG_LIMIT = 1000;

/** 脱敏路由：刻意去掉 conversationId 与 receiver（告知要素只留在桌面端存储中）。 */
export interface RouteSummary {
  id: string;
  group: string;
  contentOwner: "self" | "third-party";
  from: { platform: string; chatType: string };
  to: Array<{ platform: string; chatType: string }>;
}

/** 伴生服务向主进程索取的数据（由 main.ts 实现；standalone 用假数据）。 */
export interface CompanionStateProvider {
  getStatus(): StatusSnapshot;
  getRoutes(): RouteSummary[];
  getLogs(limit: number): LogRecord[];
  control(action: "start" | "stop"): Promise<ControlResult>;
}

export interface CompanionServerOptions {
  host: string;
  port: number;
  state: CompanionStateProvider;
  tokens: CompanionTokenStore;
  pairing: PairingManager;
  version: string;
  appName?: string;
  staticRoots?: string[];
  now?: () => number;
  onEvent?: (event: string) => void;
}

const ALLOWED_REQUEST_HEADERS = new Set(["authorization", "content-type"]);
const ALLOWED_METHODS = "GET, POST, OPTIONS";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    }
    if (parsed.protocol === "capacitor:") {
      return parsed.hostname === "localhost";
    }
    return false;
  } catch {
    return false;
  }
}

interface BodyResult {
  ok: boolean;
  status: number;
  value?: unknown;
}

/** 读取 JSON 请求体；超过 16KB 直接 413（不读取剩余内容，不反射任何字节）。 */
async function readJsonBody(request: IncomingMessage): Promise<BodyResult> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  return await new Promise<BodyResult>((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      request.removeAllListeners("data");
      request.removeAllListeners("end");
      request.removeAllListeners("error");
      resolvePromise(result);
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle({ ok: false, status: 413 });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      if (size === 0) {
        settle({ ok: false, status: 400 });
        return;
      }
      try {
        settle({ ok: true, status: 200, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        settle({ ok: false, status: 400 });
      }
    });
    request.on("error", () => {
      settle({ ok: false, status: 400 });
    });
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function clientIp(request: IncomingMessage): string {
  const address = request.socket.remoteAddress;
  if (!address) return "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/** 伴生 HTTP 服务实现。启动失败（端口占用等）由调用方决定如何提示，不在此抛到进程顶层。 */
export class CompanionServer {
  private readonly options: CompanionServerOptions;
  private server: Server | null = null;
  private staticRoot: string | null = null;
  private readonly rateLimiter: RateLimiter;
  private boundPort = 0;
  private boundHost = "";

  constructor(options: CompanionServerOptions) {
    this.options = options;
    this.rateLimiter = new RateLimiter({ limit: 5, windowMs: 60_000, ...(options.now ? { now: options.now } : {}) });
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  get address(): { host: string; port: number } {
    return { host: this.boundHost, port: this.boundPort };
  }

  get staticAvailable(): boolean {
    return this.staticRoot !== null;
  }

  get pairing(): PairingManager {
    return this.options.pairing;
  }

  get tokens(): CompanionTokenStore {
    return this.options.tokens;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      return this.address;
    }
    this.staticRoot = resolveStaticRoot(this.options.staticRoots ?? []);
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        this.event("companion_handler_error");
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        }
        if (!response.writableEnded) {
          response.end(JSON.stringify({ error: "internal_error" }));
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.server = null;
        rejectPromise(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host);
    });
    const address = server.address();
    if (address && typeof address === "object") {
      this.boundPort = address.port;
      this.boundHost = address.address;
    } else {
      this.boundPort = this.options.port;
      this.boundHost = this.options.host;
    }
    this.event("companion_started");
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
      const timer = setTimeout(() => resolvePromise(), 2000);
      timer.unref?.();
    });
    this.event("companion_stopped");
  }

  private event(name: string): void {
    try {
      this.options.onEvent?.(name);
    } catch {
      // 观测回调不得影响服务。
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 所有响应统一 no-store：状态/日志/配对结果都不得被任何中间层缓存。
    response.setHeader("cache-control", "no-store, max-age=0");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");

    const origin = request.headers.origin;
    const originAllowed = typeof origin === "string" && isAllowedOrigin(origin);
    if (originAllowed && typeof origin === "string") {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }

    if (request.method === "OPTIONS") {
      this.handlePreflight(request, response, origin, originAllowed);
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }

    if (pathname === "/api/pair") {
      await this.handlePair(request, response);
      return;
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await this.handleApi(request, response, pathname);
      return;
    }
    this.handleStatic(request, response, pathname);
  }

  private handlePreflight(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string | undefined,
    originAllowed: boolean,
  ): void {
    if (!origin) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!originAllowed) {
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    const requestedMethod = String(request.headers["access-control-request-method"] ?? "GET").toUpperCase();
    if (requestedMethod !== "GET" && requestedMethod !== "POST") {
      sendJson(response, 403, { error: "method_not_allowed" });
      return;
    }
    const requestedHeaders = String(request.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
    if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) {
      sendJson(response, 403, { error: "headers_not_allowed" });
      return;
    }
    response.setHeader("access-control-allow-methods", ALLOWED_METHODS);
    response.setHeader("access-control-allow-headers", "Authorization, Content-Type");
    response.setHeader("access-control-max-age", "600");
    response.writeHead(204);
    response.end();
  }

  private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }
    const ip = clientIp(request);
    if (this.rateLimiter.blocked(ip)) {
      sendJson(response, 429, { error: "too_many_attempts" });
      return;
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      this.rateLimiter.recordFailure(ip);
      sendJson(response, body.status, { error: "bad_request" });
      return;
    }
    const payload = body.value;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      this.rateLimiter.recordFailure(ip);
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    const code = (payload as Record<string, unknown>)["code"];
    if (typeof code !== "string" || !/^\d{6}$/u.test(code)) {
      this.rateLimiter.recordFailure(ip);
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (!this.options.pairing.redeem(code)) {
      this.rateLimiter.recordFailure(ip);
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    this.rateLimiter.reset(ip);
    const issued = this.options.tokens.issue();
    this.event("companion_paired");
    sendJson(response, 200, { token: issued.token, expiresAt: issued.expiresAt });
  }

  private authorize(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(\S+)$/iu.exec(header);
    if (!match) return false;
    const provided = match[1] ?? "";
    const current = this.options.tokens.get();
    if (!current) return false;
    if (current.expiresAt <= (this.options.now?.() ?? Date.now())) return false;
    return timingSafeEqualString(provided, current.token);
  }

  private async handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (!this.authorize(request)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    switch (pathname) {
      case "/api/health":
        if (request.method !== "GET") {
          this.methodNotAllowed(response, "GET");
          return;
        }
        sendJson(response, 200, {
          ok: true,
          app: this.options.appName ?? "im-forwarder-desktop",
          version: this.options.version,
        });
        return;

      case "/api/status":
        if (request.method !== "GET") {
          this.methodNotAllowed(response, "GET");
          return;
        }
        sendJson(response, 200, this.statusPayload());
        return;

      case "/api/routes":
        if (request.method !== "GET") {
          this.methodNotAllowed(response, "GET");
          return;
        }
        sendJson(response, 200, this.options.state.getRoutes());
        return;

      case "/api/logs":
        if (request.method !== "GET") {
          this.methodNotAllowed(response, "GET");
          return;
        }
        sendJson(response, 200, this.logsPayload(request));
        return;

      case "/api/control":
        if (request.method !== "POST") {
          this.methodNotAllowed(response, "POST");
          return;
        }
        await this.handleControl(request, response);
        return;

      default:
        sendJson(response, 404, { error: "not_found" });
    }
  }

  private methodNotAllowed(response: ServerResponse, allowed: string): void {
    sendJson(response, 405, { error: "method_not_allowed" }, { allow: allowed });
  }

  private statusPayload(): StatusSnapshot {
    const status = this.options.state.getStatus();
    // 显式重建对象：只暴露契约字段，避免上游改动意外带出会话/令牌。
    return {
      running: status.running === true,
      startedAt: typeof status.startedAt === "number" ? status.startedAt : null,
      routeCount: Number.isFinite(status.routeCount) ? Math.max(0, Math.trunc(status.routeCount)) : 0,
      gateway: {
        baseUrlHost:
          typeof status.gateway?.baseUrlHost === "string" && status.gateway.baseUrlHost.length > 0
            ? status.gateway.baseUrlHost
            : "",
      },
      crossBorderOpen: status.crossBorderOpen === true,
      counts: {
        forwarded: Math.max(0, Math.trunc(status.counts?.forwarded ?? 0)),
        failed: Math.max(0, Math.trunc(status.counts?.failed ?? 0)),
        skipped: Math.max(0, Math.trunc(status.counts?.skipped ?? 0)),
      },
    };
  }

  private logsPayload(request: IncomingMessage): LogRecord[] {
    let limit = 100;
    try {
      const parsed = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("limit");
      if (parsed !== null) {
        const value = Number(parsed);
        if (Number.isFinite(value)) {
          limit = Math.min(MAX_LOG_LIMIT, Math.max(1, Math.trunc(value)));
        }
      }
    } catch {
      limit = 100;
    }
    const records = this.options.state.getLogs(limit);
    const sanitized: LogRecord[] = [];
    for (const record of records) {
      const item = sanitizeLogRecord(record);
      if (item) sanitized.push(item);
    }
    return sanitized;
  }

  private async handleControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: "bad_request" });
      return;
    }
    const payload = body.value;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    const action = (payload as Record<string, unknown>)["action"];
    if (action !== "start" && action !== "stop") {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }

    let result: ControlResult;
    try {
      result = await this.options.state.control(action);
    } catch {
      sendJson(response, 500, { error: "control_failed" });
      return;
    }

    if (!result.ok && result.violations && result.violations.length > 0) {
      sendJson(response, 409, { violations: sanitizeViolations(result.violations), running: false });
      return;
    }
    if (!result.ok) {
      sendJson(response, 500, { error: "control_failed" });
      return;
    }
    sendJson(response, 200, { running: result.running === true });
  }

  private handleStatic(request: IncomingMessage, response: ServerResponse, pathname: string): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      return;
    }
    const root = this.staticRoot;
    if (!root) {
      sendJson(response, 503, {
        error: "static_unavailable",
        message:
          "移动端静态资源缺失：请先构建 apps/companion-web（npm --prefix apps/companion-web run build），" +
          "或使用完整安装包。API 仍可用。",
      });
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    if (decoded.includes("\0")) {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }

    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "");
    let target = resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    try {
      const stats = statSync(target);
      if (stats.isDirectory()) {
        target = join(target, "index.html");
      }
    } catch {
      // 文件不存在：SPA 路由回退到 index.html（仅当路径没有扩展名时）。
      if (extname(relative) === "") {
        target = join(root, "index.html");
      }
    }

    this.sendFile(request, response, target);
  }

  private sendFile(
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
  ): void {
    try {
      const stats = statSync(target);
      if (!stats.isFile()) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
        "content-length": stats.size,
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(target);
      stream.on("error", () => {
        if (!response.writableEnded) {
          response.destroy();
        }
      });
      stream.pipe(response);
    } catch {
      sendJson(response, 404, { error: "not_found" });
    }
  }
}

function resolveStaticRoot(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const absolute = resolve(candidate);
      if (existsSync(join(absolute, "index.html"))) {
        return absolute;
      }
    } catch {
      // 忽略非法候选路径，继续尝试下一个。
    }
  }
  return null;
}

/** 违规项对外投影：只保留 code + message（不含配置原文、路由会话 ID 以外的敏感信息）。 */
function sanitizeViolations(violations: Violation[]): Array<{ code: string; message: string }> {
  return violations.slice(0, 64).map((violation) => ({
    code: typeof violation.code === "string" ? violation.code.slice(0, 64) : "UNKNOWN",
    message: typeof violation.message === "string" ? violation.message.slice(0, 1024) : "",
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// 独立启动（无 Electron）：`node dist/companion-server.cjs` 或 `npx tsx src/companion/server.ts`
// 仅用于开发自测与 CI 的 401→pair→status→logs 全链路验证；令牌/配对码只打印到 stdout。
// ──────────────────────────────────────────────────────────────────────────

export function isStandaloneEntry(argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  const normalized = argv1.replace(/\\/gu, "/");
  return /(?:^|\/)companion\/server\.(?:ts|js|cjs)$/u.test(normalized) || /(?:^|\/)companion-server\.cjs$/u.test(normalized);
}

export async function runStandalone(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let port = Number(process.env["IM_COMPANION_PORT"] ?? 17899);
  let host = "127.0.0.1";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      const next = Number(argv[index + 1]);
      if (Number.isFinite(next) && next > 0) port = next;
      index += 1;
    } else if (arg === "--host") {
      const next = argv[index + 1];
      if (next) host = next;
      index += 1;
    }
  }

  const pairing = new PairingManager();
  const tokens = new InMemoryTokenStore({ token: process.env["IM_COMPANION_TEST_TOKEN"] });
  const ready = pairing.issue();
  const token = tokens.get();

  const provider: CompanionStateProvider = {
    getStatus: () => ({
      running: false,
      startedAt: null,
      routeCount: 2,
      gateway: { baseUrlHost: "127.0.0.1:18080" },
      crossBorderOpen: false,
      counts: { forwarded: 0, failed: 0, skipped: 0 },
    }),
    getRoutes: () => [
      {
        id: "wx-private-to-qq",
        group: "self-wx-qq",
        contentOwner: "self",
        from: { platform: "wechat", chatType: "private" },
        to: [{ platform: "qq", chatType: "private" }],
      },
      {
        id: "qq-to-wx-private",
        group: "self-wx-qq",
        contentOwner: "self",
        from: { platform: "qq", chatType: "private" },
        to: [{ platform: "wechat", chatType: "private" }],
      },
    ],
    getLogs: (limit) =>
      [
        { ts: new Date().toISOString(), level: "info" as const, event: "startup", status: "listening" },
        {
          ts: new Date().toISOString(),
          level: "info" as const,
          event: "forward",
          routeId: "wx-private-to-qq",
          sourcePlatform: "wechat",
          targetPlatform: "qq",
          status: "forwarded",
          latencyMs: 12,
        },
      ].slice(-limit),
    control: async (action) => ({
      ok: true,
      running: action === "start",
      violations: undefined,
    }),
  };

  const server = new CompanionServer({
    host,
    port,
    state: provider,
    tokens,
    pairing,
    version: "0.2.0",
    appName: "im-forwarder-desktop",
    staticRoots: [
      join(__dirname, "companion-web"),
      resolve(__dirname, "../../companion-web/dist"),
      resolve(__dirname, "../../../companion-web/dist"),
    ],
    onEvent: () => undefined,
  });

  await server.start();
  const address = server.address;
  // CI 自测脚本解析这一行；令牌只存在于本进程内存与 stdout，绝不写盘。
  process.stdout.write(
    `COMPANION_SMOKE_READY ${JSON.stringify({
      host: address.host,
      port: address.port,
      pairCode: ready.code,
      pairCodeExpiresAt: ready.expiresAt,
      token: token?.token ?? null,
      tokenExpiresAt: token?.expiresAt ?? null,
      tokenTtlMs: TOKEN_TTL_MS,
    })}\n`,
  );

  const shutdown = (): void => {
    void server.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isStandaloneEntry()) {
  runStandalone().catch(() => {
    process.stderr.write("[companion] 独立启动失败\n");
    process.exit(1);
  });
}
