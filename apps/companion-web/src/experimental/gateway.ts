/**
 * 【实验模式】EasyBot 网关直连客户端：WebSocket 订阅 + REST 发送。
 *
 * 协议边界与核心 `src/gateway/contract.ts` 一致（默认 fieldMap）：
 *  - 入站：WS 文本帧 `{type:"message", data:{...}}`，字段路径见 FIELD_MAP；
 *  - 出站：`POST {restBase}{sendPath}`，Bearer 令牌，`segments` 只有文本。
 *
 * 与核心的两处必然差异（浏览器平台限制，已在 README「实验模式限制」中说明）：
 *  1. 浏览器 WebSocket 无法设置 `Authorization` 请求头，也无法把令牌放 URL
 *     （红线：令牌不得进入 URL）。因此本客户端把令牌放进
 *     `Sec-WebSocket-Protocol` 子协议：`bearer.<base64url(token)>`。
 *     网关侧必须支持该子协议（或改为同源 Cookie 鉴权）；否则只能使用 A 模式。
 *  2. 不实现自动重连与重试：前台实验模式宁可停下让用户重连，也不静默制造重复发送。
 *
 * 安全约束：
 *  - 令牌只存在实例私有字段，`close()` 立即清空，不写任何存储/日志/URL；
 *  - 入站事件严格校验（缺字段/类型不对 ⇒ 丢弃并只上报错误码，绝不打印原始帧）；
 *  - 只构造 text 片段，媒体类型在类型层面就不存在。
 */

export type GatewayPlatform = "wechat" | "qq" | "telegram";
export type GatewayChatType = "private" | "group";
export type GatewayMessageKind =
  | "text"
  | "image"
  | "file"
  | "video"
  | "voice"
  | "at"
  | "reply"
  | "emoji"
  | "unknown";

const KNOWN_KINDS = new Set<GatewayMessageKind>([
  "text",
  "image",
  "file",
  "video",
  "voice",
  "at",
  "reply",
  "emoji",
  "unknown",
]);

const KNOWN_PLATFORMS = new Set<GatewayPlatform>(["wechat", "qq", "telegram"]);

/** 归一化后的入站消息。正文只在内存中短暂存在，且仅 kind==="text" 时非 null。 */
export interface IncomingGatewayMessage {
  platform: GatewayPlatform;
  conversationId: string;
  chatType: GatewayChatType;
  messageId: string;
  senderIsSelf: boolean;
  senderIsBot: boolean;
  kind: GatewayMessageKind;
  text: string | null;
  receivedAt: number;
}

export type GatewaySendErrorCode =
  | "b_mode_target_forbidden"
  | "gateway_not_connected"
  | "gateway_network"
  | "gateway_timeout"
  | "gateway_bad_response"
  | "gateway_rejected"
  | `gateway_http_${number}`;

export interface GatewaySendResult {
  ok: boolean;
  messageId: string | null;
  errorCode: GatewaySendErrorCode | null;
}

export type GatewayConnectionState = "idle" | "connecting" | "open" | "closed";

export interface GatewayStatus {
  state: GatewayConnectionState;
  /** 仅错误码，不含任何正文/令牌。 */
  code: string | null;
}

/** 默认字段映射，与核心 `DEFAULT_FIELD_MAP` 保持一致。 */
export const GATEWAY_FIELD_MAP = {
  platform: "data.platform",
  conversationId: "data.conversation.id",
  chatType: "data.conversation.type",
  messageId: "data.message.id",
  kind: "data.message.kind",
  text: "data.message.text",
  senderId: "data.sender.id",
  senderIsSelf: "data.sender.isSelf",
  senderIsBot: "data.sender.isBot",
  timestamp: "data.timestamp",
} as const;

export interface EndpointValidation {
  url: string;
}

export interface EndpointError {
  error: string;
}

const WS_PROTOCOLS = new Set(["ws:", "wss:"]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 校验并归一化网关地址。
 * 只允许 ws/wss（WS）与 http/https（REST）；拒绝 URL 内嵌用户名/密码。
 */
export function normalizeGatewayUrl(input: string, kind: "ws" | "rest"): EndpointValidation | EndpointError {
  const raw = input.trim();
  if (raw.length === 0) {
    return { error: kind === "ws" ? "请填写网关 WebSocket 地址" : "请填写网关 REST 地址" };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)
    ? raw
    : kind === "ws"
      ? `ws://${raw}`
      : `http://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "地址格式不正确，例如 ws://192.168.1.8:18080/ws/events" };
  }

  const allowed = kind === "ws" ? WS_PROTOCOLS : HTTP_PROTOCOLS;
  if (!allowed.has(url.protocol)) {
    return {
      error: kind === "ws" ? "WebSocket 地址只允许 ws:// 或 wss://" : "REST 地址只允许 http:// 或 https://",
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { error: "地址中不能包含用户名或密码" };
  }
  if (url.hostname === "") {
    return { error: "地址缺少主机名" };
  }

  if (kind === "rest") {
    url.hash = "";
    url.search = "";
    return { url: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}` };
  }
  url.hash = "";
  return { url: url.toString() };
}

function readPath(source: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    const record = current as Record<string, unknown>;
    if (segment in record) {
      current = record[segment];
      continue;
    }
    if (/^\d+$/u.test(segment)) {
      const index = Number.parseInt(segment, 10);
      if (Array.isArray(current) && index in current) {
        current = (current as unknown[])[index];
        continue;
      }
    }
    return undefined;
  }
  return current;
}

/**
 * 把网关原始事件归一化为 `IncomingGatewayMessage`。
 * 任何必需字段缺失/类型错误 ⇒ 返回 null（fail-closed，与核心 `mapping.ts` 一致）。
 * 该函数是纯函数，便于单元测试。
 */
export function parseGatewayMessage(raw: unknown, now: () => number = () => Date.now()): IncomingGatewayMessage | null {
  if (typeof raw !== "object" || raw === null) return null;

  const platform = readPath(raw, GATEWAY_FIELD_MAP.platform);
  if (typeof platform !== "string" || !KNOWN_PLATFORMS.has(platform as GatewayPlatform)) return null;

  const conversationId = readPath(raw, GATEWAY_FIELD_MAP.conversationId);
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) return null;

  const chatType = readPath(raw, GATEWAY_FIELD_MAP.chatType);
  if (chatType !== "private" && chatType !== "group") return null;

  const messageId = readPath(raw, GATEWAY_FIELD_MAP.messageId);
  if (typeof messageId !== "string" || messageId.trim().length === 0) return null;

  const rawKind = readPath(raw, GATEWAY_FIELD_MAP.kind);
  const kind: GatewayMessageKind =
    typeof rawKind === "string" && KNOWN_KINDS.has(rawKind as GatewayMessageKind)
      ? (rawKind as GatewayMessageKind)
      : "unknown";

  // 只有 text 才读取正文；其它类型一律置 null —— 从结构上杜绝媒体/富文本进入本客户端。
  let text: string | null = null;
  if (kind === "text") {
    const rawText = readPath(raw, GATEWAY_FIELD_MAP.text);
    if (typeof rawText !== "string") return null;
    text = rawText;
  }

  const senderIsSelfRaw = readPath(raw, GATEWAY_FIELD_MAP.senderIsSelf);
  const senderIsBotRaw = readPath(raw, GATEWAY_FIELD_MAP.senderIsBot);
  const timestampRaw = readPath(raw, GATEWAY_FIELD_MAP.timestamp);

  return {
    platform: platform as GatewayPlatform,
    conversationId,
    chatType,
    messageId,
    senderIsSelf: senderIsSelfRaw === true,
    senderIsBot: senderIsBotRaw === true,
    kind,
    text,
    receivedAt:
      typeof timestampRaw === "number" && Number.isFinite(timestampRaw) ? Math.trunc(timestampRaw) : now(),
  };
}

/** base64url（无填充）。浏览器 WebSocket 子协议令牌必须只含 RFC 7230 token 字符。 */
export function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += alphabet[(buffer >> bits) & 0x3f] as string;
    }
  }
  if (bits > 0) {
    output += alphabet[(buffer << (6 - bits)) & 0x3f] as string;
  }
  return output;
}

/** WebSocket 子协议名：网关侧据此识别 Bearer 令牌。 */
export const WS_TOKEN_SUBPROTOCOL_PREFIX = "bearer.";
export const WS_APP_SUBPROTOCOL = "im-forwarder.v1";

export interface GatewayClientOptions {
  /** 测试注入；默认全局 fetch。 */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 测试注入；默认全局 WebSocket。 */
  webSocketImpl?: typeof WebSocket;
  /** 发送端点路径，默认与核心一致。 */
  sendPath?: string;
  requestTimeoutMs?: number;
  now?: () => number;
}

export interface GatewayClientCallbacks {
  onMessage: (message: IncomingGatewayMessage) => void;
  onStatus?: (status: GatewayStatus) => void;
}

export class GatewayClient {
  private readonly wsUrl: string;
  private readonly restUrl: string;
  private readonly sendPath: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly webSocketImpl: typeof WebSocket;
  private readonly now: () => number;
  private readonly callbacks: GatewayClientCallbacks;

  /** 只存在内存的令牌；close() 立即清空。 */
  private token: string;
  private socket: WebSocket | null = null;
  private state: GatewayConnectionState = "idle";

  constructor(
    config: { wsUrl: string; restUrl: string; token: string },
    callbacks: GatewayClientCallbacks,
    options: GatewayClientOptions = {},
  ) {
    const ws = normalizeGatewayUrl(config.wsUrl, "ws");
    if ("error" in ws) throw new Error(ws.error);
    const rest = normalizeGatewayUrl(config.restUrl, "rest");
    if ("error" in rest) throw new Error(rest.error);
    if (config.token.trim().length === 0) throw new Error("网关令牌不能为空（只保存在内存）");

    this.wsUrl = ws.url;
    this.restUrl = rest.url;
    this.token = config.token;
    this.sendPath = options.sendPath ?? "/api/v1/messages/send";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.webSocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
    this.now = options.now ?? (() => Date.now());
    this.callbacks = callbacks;
  }

  get connectionState(): GatewayConnectionState {
    return this.state;
  }

  /** 令牌是否存在（不暴露令牌本身，供 UI 判断是否已清理）。 */
  get hasToken(): boolean {
    return this.token.length > 0;
  }

  /**
   * 建立 WS 连接。
   * 认证走子协议（浏览器无法设置 Authorization 头）。失败时抛出可读错误，
   * 由 runner 转成"建议改用 A 模式"的提示。
   */
  async connect(): Promise<void> {
    if (this.state === "open") return;
    if (typeof this.webSocketImpl !== "function") {
      throw new Error("当前环境不支持 WebSocket，实验模式无法启动");
    }
    this.setState("connecting");

    const protocols = [WS_APP_SUBPROTOCOL, `${WS_TOKEN_SUBPROTOCOL_PREFIX}${base64UrlEncode(this.token)}`];

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new this.webSocketImpl(this.wsUrl, protocols);
      } catch {
        this.setState("closed");
        reject(new Error("WebSocket 地址无效或浏览器拒绝了子协议，请检查网关地址"));
        return;
      }
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.onopen = () => {
        settled = true;
        this.setState("open");
        resolve();
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          this.setState("closed", "gateway_connect_failed");
          reject(this.connectError());
        }
      };
      socket.onclose = (event) => {
        this.socket = null;
        this.setState("closed", `ws_close_${event.code}`);
        if (!settled) {
          settled = true;
          reject(this.connectError());
        }
      };
      socket.onmessage = (event) => {
        this.handleFrame(event.data);
      };
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000, "b-mode-stop");
      } catch {
        // 忽略关闭异常。
      }
    }
    // 关键红线：停止即清空内存令牌。
    this.token = "";
    this.setState("closed");
  }

  /**
   * 发送一条纯文本消息。
   * 只允许 wechat/qq 目标（Telegram 目标在实验模式被拒绝，且不会走到网络层）。
   */
  async sendText(input: {
    platform: GatewayPlatform;
    conversationId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<GatewaySendResult> {
    if (input.platform !== "wechat" && input.platform !== "qq") {
      return { ok: false, messageId: null, errorCode: "b_mode_target_forbidden" };
    }
    if (this.token.length === 0) {
      return { ok: false, messageId: null, errorCode: "gateway_not_connected" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.restUrl}${this.sendPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          platform: input.platform,
          conversationId: input.conversationId,
          segments: [{ type: "text", text: input.text }],
          idempotencyKey: input.idempotencyKey,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const code: GatewaySendErrorCode =
        error instanceof Error && error.name === "AbortError" ? "gateway_timeout" : "gateway_network";
      return { ok: false, messageId: null, errorCode: code };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { ok: false, messageId: null, errorCode: `gateway_http_${response.status}` };
    }
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      return { ok: false, messageId: null, errorCode: "gateway_bad_response" };
    }
    if (typeof body !== "object" || body === null || typeof (body as { ok?: unknown }).ok !== "boolean") {
      return { ok: false, messageId: null, errorCode: "gateway_bad_response" };
    }
    const record = body as { ok: boolean; messageId?: unknown };
    if (record.ok !== true) {
      // 不透明化网关原始 errorCode：避免远端字符串进入 UI/日志。
      return { ok: false, messageId: null, errorCode: "gateway_rejected" };
    }
    return {
      ok: true,
      messageId: typeof record.messageId === "string" && record.messageId.length > 0 ? record.messageId : null,
      errorCode: null,
    };
  }

  /** 仅上报状态/错误码；绝不外传原始帧或正文。 */
  private handleFrame(data: unknown): void {
    if (typeof data !== "string") {
      this.callbacks.onStatus?.({ state: this.state, code: "ws_binary_frame_ignored" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.callbacks.onStatus?.({ state: this.state, code: "ws_bad_frame" });
      return;
    }
    const message = parseGatewayMessage(parsed, this.now);
    if (message === null) {
      this.callbacks.onStatus?.({ state: this.state, code: "ws_unmapped_event" });
      return;
    }
    this.callbacks.onMessage(message);
  }

  private setState(state: GatewayConnectionState, code: string | null = null): void {
    this.state = state;
    this.callbacks.onStatus?.({ state, code });
  }

  private connectError(): Error {
    return new Error(
      "无法建立网关 WebSocket 连接。浏览器直连需要网关同时满足：① 允许本页面来源的 CORS；" +
        "② 接受 `" + WS_TOKEN_SUBPROTOCOL_PREFIX + "<base64url(token)>` 子协议鉴权。若网关不支持，请改用 A 模式（经桌面端转发）。",
    );
  }
}
