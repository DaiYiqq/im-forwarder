/**
 * 全局领域类型。
 *
 * 本文件与平台协议无关：它描述的是"网关已经归一化之后"的消息。
 * 任何平台特有的字段、登录、鉴权、协议解析都不得出现在本仓库源码中。
 */

export type Platform = "wechat" | "qq" | "telegram";

export const PLATFORMS: readonly Platform[] = ["wechat", "qq", "telegram"] as const;

export type ChatType = "private" | "group";

export type MessageKind =
  | "text"
  | "image"
  | "file"
  | "video"
  | "voice"
  | "at"
  | "reply"
  | "emoji"
  | "unknown";

/**
 * 允许参与转发的消息类型白名单。
 *
 * 只做文本。媒体一律"显式回执 + 跳过"：不静默丢弃，也不自行下载/解码/逆向。
 * 见 COMPLIANCE.md「媒体处理」一节。
 */
export const SUPPORTED_KINDS: readonly MessageKind[] = ["text"] as const;

/** 路由端点：平台 + 会话 + 会话类型。三者共同构成路由矩阵的节点。 */
export interface EndpointRef {
  platform: Platform;
  conversationId: string;
  chatType: ChatType;
}

/** 网关推送进来、并已完成归一化的入站消息。正文只在内存中短暂存在。 */
export interface IncomingMessage {
  platform: Platform;
  conversationId: string;
  chatType: ChatType;
  messageId: string;
  senderId: string;
  /** 该消息是否由本服务所登录的账号/机器人自己发出（用于过滤自回显）。 */
  senderIsSelf: boolean;
  /** 发送方是否为机器人（防止两个机器人互相触发形成无限循环）。 */
  senderIsBot: boolean;
  kind: MessageKind;
  /** 仅当 kind === "text" 时存在；其它类型为 null。 */
  text: string | null;
  /** 毫秒时间戳，用于同意回执的冷却判定等。 */
  receivedAt: number;
}

/** 待发送的出站文本。注意：只有文本，无媒体字段——从类型上就无法夹带媒体。 */
export interface OutgoingText {
  platform: Platform;
  conversationId: string;
  text: string;
  /** 幂等键：重试时网关据此去重，避免同一条消息发两次。 */
  idempotencyKey: string;
}

/** 发送结果。不包含正文，可安全写入日志。 */
export interface SendOutcome {
  ok: boolean;
  messageId: string | null;
  errorCode: string | null;
  latencyMs: number;
}

/** 单条消息的处理结论状态（写入日志的 status 字段）。 */
export type ForwardStatus =
  | "forwarded"
  | "skipped_self"
  | "skipped_bot"
  | "skipped_group_forbidden"
  | "skipped_no_route"
  | "skipped_unsupported_kind"
  | "skipped_loop_suspected"
  | "blocked_cross_border"
  | "blocked_consent_pending"
  | "notice_sent"
  | "send_failed"
  | "consent_recorded"
  | "consent_revoked";
