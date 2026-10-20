/**
 * 网关层错误归一化。
 *
 * 安全约束：错误码必须是本服务自己定义的稳定标识，绝不能把网关响应体、
 * 原始报文、异常 message 拼接进去——那些内容可能包含消息正文或凭证。
 */

import { GatewayError } from "./contract";

/**
 * 固定错误码白名单（与 docs/GATEWAY-CONTRACT.md 的错误码表一致）。
 * HTTP 状态类错误另以 `gateway_http_<status>` 的形式动态生成，见下方正则。
 */
export const STABLE_ERROR_CODES = [
  "gateway_timeout",
  "gateway_network",
  "gateway_bad_response",
  "gateway_rejected",
  "gateway_bad_request",
  "gateway_unknown_error",
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

/** 形如 gateway_http_500 的动态 HTTP 状态码。 */
const HTTP_STATUS_CODE_PATTERN = /^gateway_http_[1-5]\d{2}$/;
/** 本服务自定义的稳定 code 形态：小写蛇形，长度受限。 */
const STABLE_CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * 网关传输层错误：带 HTTP 状态码（网络层错误时为 null）。
 *
 * 只暴露状态码与稳定 code，不携带请求体/响应体。
 */
export class GatewayTransportError extends GatewayError {
  /** HTTP 状态码；非 HTTP 阶段（DNS/连接/超时）为 null。 */
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    status: number | null = null,
    retryable: boolean = false,
  ) {
    super(code, message, retryable);
    this.name = "GatewayTransportError";
    this.status = status;
  }
}

function isStableCode(value: string): boolean {
  return STABLE_CODE_PATTERN.test(value) || HTTP_STATUS_CODE_PATTERN.test(value);
}

/** 判断是否超时/中止类异常（fetch 的 AbortSignal.timeout 抛 TimeoutError）。 */
function isTimeoutLike(error: object): boolean {
  const name = (error as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT";
}

/**
 * 把任意异常归一化成稳定错误码。
 *
 * 规则（不含任何响应体/异常 message）：
 *   - GatewayError（含 GatewayTransportError）→ 校验后的 code；
 *   - 超时/中止类 → gateway_timeout；
 *   - TypeError / 连接类（ECONNREFUSED、ECONNRESET、ENOTFOUND、EAI_AGAIN、UND_ERR_*）→ gateway_network；
 *   - 其它 → gateway_unknown_error。
 */
export function toErrorCode(error: unknown): string {
  if (error instanceof GatewayError) {
    return isStableCode(error.code) ? error.code : "gateway_unknown_error";
  }

  if (error === null || error === undefined) {
    return "gateway_unknown_error";
  }

  // 字符串只可能是本服务内部传入的稳定 code，仍做白名单校验。
  if (typeof error === "string") {
    return isStableCode(error) ? error : "gateway_unknown_error";
  }

  if (typeof error === "object") {
    if (isTimeoutLike(error)) {
      return "gateway_timeout";
    }

    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      if (
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN" ||
        code === "EPIPE" ||
        code === "EHOSTUNREACH" ||
        code === "ENETUNREACH" ||
        code === "UND_ERR_SOCKET" ||
        code === "UND_ERR_CLOSED"
      ) {
        return "gateway_network";
      }
      // 网络异常可能带系统 errno（如 "ECONNREFUSED"），不应直接外泄；命中白名单才返回。
      if (isStableCode(code)) {
        return code;
      }
    }

    if (error instanceof TypeError) {
      return "gateway_network";
    }

    const name = (error as { name?: unknown }).name;
    if (name === "FetchError" || name === "SocketError") {
      return "gateway_network";
    }
  }

  return "gateway_unknown_error";
}
