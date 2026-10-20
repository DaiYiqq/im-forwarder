/**
 * 唯一协议边界。
 *
 * 本服务是"网关之上的转发路由服务"：它只认识下面这份契约，
 * 不认识微信 iLink 的连接细节、不认识 NapCat 的 OneBot 帧、
 * 也不认识 Telegram 的任何协议层实现。
 *
 * 为什么这样切：把协议边界收敛到一个文件，是本项目最重要的合规结构之一——
 *   - 本仓库不存在任何微信登录/取票/扫码代码（iLink 由网关侧官方通道完成）；
 *   - 本仓库不存在任何 QQ 登录代码（NapCat 由网关侧完成）；
 *   - 本仓库不存在任何 userbot（MTProto/Telethon/Pyrogram）代码路径，
 *     因为出站只允许 Telegram 官方 Bot API 形态的 HTTP 调用（由网关完成）。
 *
 * 若你更换网关版本或字段命名，只需修改 gateway/mapping.ts 与配置里的 fieldMap，
 * 不需要（也不允许）在本仓库引入任何平台 SDK。
 */

import type { IncomingMessage, Platform, SendOutcome } from "../types";

/** 出站消息片段。只允许文本，媒体片段在类型层面就不存在。 */
export interface GatewaySegment {
  type: "text";
  text: string;
}

/** 统一发送请求（网关 REST 端点）。 */
export interface GatewaySendRequest {
  platform: Platform;
  conversationId: string;
  segments: GatewaySegment[];
  /** 幂等键：网关可据此去重；本服务重试时不会重复发送。 */
  idempotencyKey: string;
  /** 非用户可见的元数据通道：用于回环防护的可选回显标记。 */
  metadata?: Record<string, string>;
}

/** 网关发送响应（归一化后的最小集合）。 */
export interface GatewaySendResponse {
  ok: boolean;
  messageId?: string | null;
  errorCode?: string | null;
}

/**
 * 网关 WS 推送的原始事件。结构由网关决定，通过 fieldMap 映射到统一模型。
 * 本服务从不信任其中的任何字段类型，一律在 mapping.ts 中做运行时校验。
 */
export type GatewayRawEvent = Record<string, unknown>;

/**
 * 字段路径映射：值为点号路径（如 "data.message.text"）。
 * 让同一个服务可以对接不同版本的网关，而不必改代码。
 */
export interface GatewayFieldMap {
  platform: string;
  conversationId: string;
  chatType: string;
  messageId: string;
  kind: string;
  text: string;
  senderId: string;
  senderIsSelf: string;
  senderIsBot: string;
  timestamp: string;
}

/** 默认契约：与 docs/GATEWAY-CONTRACT.md 保持一致。 */
export const DEFAULT_FIELD_MAP: GatewayFieldMap = {
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
};

/** 出站客户端接口。实现必须做超时、重试与幂等，且不得记录正文。 */
export interface GatewayClient {
  send(request: GatewaySendRequest): Promise<SendOutcome>;
}

/** 入站事件源接口。实现负责连接、重连与健康检查。 */
export interface GatewayEventSource {
  start(onMessage: (message: IncomingMessage) => void): Promise<void>;
  stop(): Promise<void>;
}

/** 网关投递失败时的错误码（不含任何平台原始报文）。 */
export class GatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.retryable = retryable;
  }
}
