/**
 * HTTP 出站客户端：本服务向网关发送消息的唯一通道。
 *
 * 安全与稳定性约束：
 *   - 只访问配置里的 baseUrl，不直连任何平台域名；
 *   - 请求体只包含文本片段与幂等键，不包含任何平台凭证/会话 cookie；
 *   - 响应体只用于判定成功/失败与取 messageId，绝不进入错误码或日志；
 *   - 重试仅针对「网络错误 / HTTP 5xx / HTTP 429」，4xx 立即失败；
 *   - 每次尝试通过 onDiagnostic 只上报 code/attempt/status 这类元数据。
 */

import type { SendOutcome } from "../types";
import type { GatewayClient, GatewaySendRequest } from "./contract";
import { GatewayTransportError, toErrorCode } from "./errors";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES_LIMIT = 10;
const RETRY_BASE_DELAY_MS = 200;

export interface HttpGatewayClientOptions {
  baseUrl: string;
  sendPath: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  onDiagnostic?: (code: string, info?: Record<string, string | number | boolean>) => void;
}

/** 单次尝试的归一化结果（内部类型，不对外暴露）。 */
type AttemptResult =
  | { kind: "success"; messageId: string | null }
  | { kind: "failure"; code: string; status: number | null; retryable: boolean };

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isHttpEndpoint(endpoint: string): boolean {
  return /^https?:\/\/[^/]+/i.test(endpoint);
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT";
}

/** 指数退避 + 抖动，避免大量实例同时重试。 */
function retryDelayMs(attempt: number): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(5_000, exponential);
  return capped + Math.floor(Math.random() * (capped / 4 + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 丢弃响应体（不读取正文，避免正文进入任何日志/诊断）。 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 取消失败不影响判定，且绝不回读正文。
  }
}

export class HttpGatewayClient implements GatewayClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onDiagnostic?: (
    code: string,
    info?: Record<string, string | number | boolean>,
  ) => void;

  constructor(options: HttpGatewayClientOptions) {
    const base = typeof options.baseUrl === "string" ? options.baseUrl.trim() : "";
    const sendPath = typeof options.sendPath === "string" ? options.sendPath.trim() : "";
    const normalizedPath = sendPath.length === 0 ? "" : sendPath.startsWith("/") ? sendPath : `/${sendPath}`;

    this.endpoint = `${base.replace(/\/+$/, "")}${normalizedPath}`;
    this.token = typeof options.token === "string" ? options.token : "";
    this.timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000);
    this.maxRetries = clampInt(options.maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES_LIMIT);
    this.onDiagnostic = options.onDiagnostic;
  }

  /** 发送一条文本消息；本方法不会抛异常，一切失败都归一化为 SendOutcome。 */
  async send(request: GatewaySendRequest): Promise<SendOutcome> {
    const startedAt = Date.now();
    const totalAttempts = this.maxRetries + 1;
    let attempt = 0;

    while (attempt < totalAttempts) {
      attempt += 1;
      this.diagnostic("send_attempt", { attempt, status: 0 });

      let result: AttemptResult;
      try {
        result = await this.attemptOnce(request);
      } catch (error) {
        // attemptOnce 内部已兜底；这里再兜一层，绝不让异常穿透到调用方。
        result = {
          kind: "failure",
          code: toErrorCode(error),
          status: null,
          retryable: false,
        };
      }

      if (result.kind === "success") {
        return {
          ok: true,
          messageId: result.messageId,
          errorCode: null,
          latencyMs: Math.max(0, Date.now() - startedAt),
        };
      }

      const hasNextAttempt = attempt < totalAttempts;
      if (!result.retryable || !hasNextAttempt) {
        this.diagnostic(result.code, { attempt, status: result.status ?? 0 });
        return {
          ok: false,
          messageId: null,
          errorCode: result.code,
          latencyMs: Math.max(0, Date.now() - startedAt),
        };
      }

      const delayMs = retryDelayMs(attempt);
      this.diagnostic("send_retry", { attempt, status: result.status ?? 0, delayMs });
      await sleep(delayMs);
    }

    // 理论上不可达（循环内必然返回）；保底返回稳定错误码。
    return {
      ok: false,
      messageId: null,
      errorCode: "gateway_unknown_error",
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }

  private async attemptOnce(request: GatewaySendRequest): Promise<AttemptResult> {
    if (!isHttpEndpoint(this.endpoint)) {
      return { kind: "failure", code: "gateway_bad_request", status: null, retryable: false };
    }

    let body: string;
    try {
      const payload: Record<string, unknown> = {
        platform: request.platform,
        conversationId: request.conversationId,
        segments: request.segments.map((segment) => ({ type: "text", text: segment.text })),
        idempotencyKey: request.idempotencyKey,
      };
      if (request.metadata && Object.keys(request.metadata).length > 0) {
        payload.metadata = request.metadata;
      }
      body = JSON.stringify(payload);
    } catch {
      // 例如 metadata 里有循环引用：这是调用方构造的非法请求，重试无意义。
      return { kind: "failure", code: "gateway_bad_request", status: null, retryable: false };
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = isTimeoutError(error);
      return {
        kind: "failure",
        code: timedOut ? "gateway_timeout" : "gateway_network",
        status: null,
        // 网络层错误与超时可重试（幂等键保证网关侧可去重）。
        retryable: true,
      };
    }

    const status = typeof response.status === "number" ? response.status : 0;

    // 5xx / 429：可重试；正文一律丢弃。
    if (status === 429 || status >= 500) {
      await discardBody(response);
      return { kind: "failure", code: `gateway_http_${status}`, status, retryable: true };
    }

    // 其它非 2xx（4xx 等）：不可重试。
    if (!response.ok) {
      await discardBody(response);
      return { kind: "failure", code: `gateway_http_${status}`, status, retryable: false };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { kind: "failure", code: "gateway_bad_response", status, retryable: false };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "failure", code: "gateway_bad_response", status, retryable: false };
    }

    const record = parsed as Record<string, unknown>;
    if (record.ok === true) {
      const messageId =
        typeof record.messageId === "string" && record.messageId.trim().length > 0
          ? record.messageId
          : null;
      return { kind: "success", messageId };
    }

    if (record.ok === false) {
      // 不把网关给的 errorCode 原样透出：只返回本服务的稳定错误码。
      return { kind: "failure", code: "gateway_rejected", status, retryable: false };
    }

    return { kind: "failure", code: "gateway_bad_response", status, retryable: false };
  }

  private diagnostic(code: string, info?: Record<string, string | number | boolean>): void {
    if (!this.onDiagnostic) {
      return;
    }
    try {
      this.onDiagnostic(code, info);
    } catch {
      // 诊断回调是观测通道，绝不能影响发送主流程。
    }
  }
}

/** 供调用方复用的错误类型（保留导出，便于上层 instanceof 判定）。 */
export { GatewayTransportError };
