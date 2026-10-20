/**
 * WebSocket 入站事件源：本服务接收网关推送的唯一通道。
 *
 * 行为约定：
 *   - 只接受文本帧；二进制帧直接忽略并上报诊断码；
 *   - JSON.parse 失败只上报 ws_bad_frame，绝不打印帧内容；
 *   - 每帧都走 normalizeGatewayEvent；归一化失败上报 ws_unmapped_event 后丢弃；
 *   - 断线自动重连（1s 起，30s 封顶，指数退避 + 抖动）；stop() 之后不再重连；
 *   - start() 在「首次连接建立」或「首次连接失败」后 resolve，
 *     连接失败时后台继续重连，绝不把进程挂死。
 */

import { WebSocket } from "ws";
import type { RawData } from "ws";

import type { IncomingMessage } from "../types";
import type { GatewayEventSource, GatewayFieldMap, GatewayRawEvent } from "./contract";
import { normalizeGatewayEvent } from "./mapping";

const DEFAULT_MIN_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface WebSocketEventSourceOptions {
  wsUrl: string;
  token: string;
  fieldMap?: GatewayFieldMap;
  reconnect?: { minDelayMs?: number; maxDelayMs?: number };
  onDiagnostic?: (code: string, info?: Record<string, string | number | boolean>) => void;
}

function clampDelay(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export class WebSocketEventSource implements GatewayEventSource {
  private readonly wsUrl: string;
  private readonly token: string;
  private readonly fieldMap: GatewayFieldMap | undefined;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly onDiagnostic?: (
    code: string,
    info?: Record<string, string | number | boolean>,
  ) => void;

  private socket: WebSocket | null = null;
  private handler: ((message: IncomingMessage) => void) | null = null;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  private startResolve: (() => void) | null = null;

  constructor(options: WebSocketEventSourceOptions) {
    this.wsUrl = typeof options.wsUrl === "string" ? options.wsUrl : "";
    this.token = typeof options.token === "string" ? options.token : "";
    this.fieldMap = options.fieldMap;
    this.minDelayMs = clampDelay(options.reconnect?.minDelayMs, DEFAULT_MIN_DELAY_MS, 50, 60_000);
    this.maxDelayMs = clampDelay(
      options.reconnect?.maxDelayMs,
      DEFAULT_MAX_DELAY_MS,
      this.minDelayMs,
      600_000,
    );
    this.onDiagnostic = options.onDiagnostic;
  }

  /**
   * 建立连接并开始消费事件。
   *
   * 返回值只表示「首次尝试已尘埃落定」（成功 open 或首次失败），
   * 不表示连接会一直保持——断线重连在后台进行。
   */
  start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    this.handler = onMessage;

    if (this.startPromise && !this.stopped) {
      return this.startPromise;
    }

    this.stopped = false;
    this.startPromise = new Promise<void>((resolve) => {
      this.startResolve = resolve;
    });
    this.connect();
    return this.startPromise;
  }

  /** 停止消费并终止当前连接；可重复调用。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    this.settleStart();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        // 先摘掉业务监听，防止 terminate 触发的 close 再次排重连。
        socket.removeAllListeners();
        socket.on("error", () => {
          // 终止阶段的错误无需上报，也不能变成未处理异常。
        });
        socket.terminate();
      } catch {
        // 已关闭时 terminate 可能抛错，忽略即可。
      }
    }

    this.startPromise = null;
    this.reconnectAttempt = 0;
    this.diagnostic("ws_stopped");
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    this.clearReconnectTimer();

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.wsUrl, {
        headers: { authorization: `Bearer ${this.token}` },
        // 握手阶段最长等待 10s；超时按失败处理并进入重连，避免 start() 永久挂起。
        handshakeTimeout: 10_000,
      });
    } catch {
      // 例如 wsUrl 非法：不重连已无意义，但要 resolve start，避免调用方永久等待。
      this.diagnostic("ws_connect_failed", { attempt: this.reconnectAttempt });
      this.settleStart();
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    this.diagnostic("ws_connecting", { attempt: this.reconnectAttempt });

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.diagnostic("ws_open");
      this.settleStart();
    });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      this.handleFrame(data, isBinary);
    });

    socket.on("error", () => {
      // 不记录异常 message（可能含 URL 或服务端返回文本）。
      this.diagnostic("ws_error");
      // ws 在 error 之后通常紧跟 close，重连逻辑放在 close 中统一处理；
      // 但若 socket 已彻底关闭，这里兜底 resolve 首次 start。
      if (socket.readyState === WebSocket.CLOSED) {
        this.settleStart();
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.settleStart();
      if (this.stopped) {
        this.diagnostic("ws_closed");
        return;
      }
      this.scheduleReconnect();
    });
  }

  private handleFrame(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.diagnostic("ws_binary_frame_ignored");
      return;
    }

    let text: string;
    try {
      if (Buffer.isBuffer(data)) {
        text = data.toString("utf8");
      } else if (Array.isArray(data)) {
        text = Buffer.concat(data).toString("utf8");
      } else {
        text = Buffer.from(data).toString("utf8");
      }
    } catch {
      this.diagnostic("ws_bad_frame");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 只上报诊断码，不打印帧内容（帧里可能有消息正文）。
      this.diagnostic("ws_bad_frame");
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.diagnostic("ws_unmapped_event");
      return;
    }

    const message = normalizeGatewayEvent(parsed as GatewayRawEvent, this.fieldMap);
    if (message === null) {
      this.diagnostic("ws_unmapped_event");
      return;
    }

    try {
      this.handler?.(message);
    } catch {
      // 消费方异常不应打断 WS 事件循环。
      this.diagnostic("ws_handler_error");
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const attempt = this.reconnectAttempt;
    const exponential = Math.min(this.maxDelayMs, this.minDelayMs * 2 ** Math.min(attempt, 12));
    const jitter = Math.floor(Math.random() * Math.min(250, exponential / 4 + 1));
    const delayMs = Math.min(this.maxDelayMs, exponential + jitter);
    this.reconnectAttempt += 1;

    this.diagnostic("ws_reconnect_scheduled", { delayMs, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 让 start() 的 Promise 落定（只落定一次）。 */
  private settleStart(): void {
    const resolve = this.startResolve;
    this.startResolve = null;
    resolve?.();
  }

  private diagnostic(code: string, info?: Record<string, string | number | boolean>): void {
    if (!this.onDiagnostic) {
      return;
    }
    try {
      this.onDiagnostic(code, info);
    } catch {
      // 诊断通道不得影响事件消费。
    }
  }
}
