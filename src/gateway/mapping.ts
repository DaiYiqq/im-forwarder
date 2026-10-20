/**
 * 网关原始事件 -> 统一领域模型的映射层。
 *
 * 设计原则（fail-closed，宁可丢也不猜）：
 *   - 网关推来的 JSON 一律视为"不可信输入"，逐字段做运行时类型校验；
 *   - 任何路由必需字段（platform / conversationId / messageId / chatType）
 *     缺失或非法，直接返回 null，由调用方丢弃并记录诊断码，绝不做默认值猜测；
 *   - 尤其 chatType：缺失或非法一律不当作 private，避免把群聊消息误判为私聊；
 *   - text 仅在 kind === "text" 时读取；其余类型 text 固定为 null。
 *
 * 本文件不含任何平台协议知识，只认识 fieldMap 里的点号路径。
 */

import type { ChatType, IncomingMessage, MessageKind, Platform } from "../types";
import { PLATFORMS } from "../types";
import type { GatewayFieldMap, GatewayRawEvent } from "./contract";
import { DEFAULT_FIELD_MAP } from "./contract";

/** 全部已知消息类型（与 types.ts 的 MessageKind 保持同步）。 */
const KNOWN_KINDS: readonly MessageKind[] = [
  "text",
  "image",
  "file",
  "video",
  "voice",
  "at",
  "reply",
  "emoji",
  "unknown",
];

const KNOWN_CHAT_TYPES: readonly ChatType[] = ["private", "group"];

/**
 * 按点号路径取值，例如 "data.conversation.id"。
 *
 * - 只读自身属性（不沿原型链），避免 "__proto__" 之类的路径造成原型污染；
 * - 支持数组下标（"data.messages.0.text"），属于可选便利，默认契约不依赖；
 * - 任何一段不存在、类型不可继续下降，统一返回 undefined（不抛异常）。
 */
export function getByPath(root: unknown, path: string): unknown {
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }

  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (segment.length === 0) {
      return undefined;
    }

    if (Array.isArray(cursor)) {
      // 数组下标：只接受纯十进制数字，避免把 "length" 之类当成下标。
      if (!/^\d+$/.test(segment)) {
        return undefined;
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isSafeInteger(index) || index >= cursor.length) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }

    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

/** 非空字符串校验：空白串视为非法（拿不到可靠 ID 就不能安全去重/路由）。 */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length === 0 || value.trim().length === 0) {
    return null;
  }
  return value;
}

function asPlatform(value: unknown): Platform | null {
  if (typeof value !== "string") {
    return null;
  }
  return (PLATFORMS as readonly string[]).includes(value) ? (value as Platform) : null;
}

function asChatType(value: unknown): ChatType | null {
  if (typeof value !== "string") {
    return null;
  }
  return (KNOWN_CHAT_TYPES as readonly string[]).includes(value) ? (value as ChatType) : null;
}

function asKind(value: unknown): MessageKind {
  if (typeof value === "string" && (KNOWN_KINDS as readonly string[]).includes(value)) {
    return value as MessageKind;
  }
  return "unknown";
}

function asOptionalBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function asTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return Date.now();
}

/**
 * 把网关原始事件归一化为 IncomingMessage。
 *
 * @param raw      网关 WS 帧经 JSON.parse 后的对象（不可信）
 * @param fieldMap 字段路径映射，缺省使用 DEFAULT_FIELD_MAP
 * @returns 合法消息；任一必填字段缺失/非法时返回 null
 */
export function normalizeGatewayEvent(
  raw: GatewayRawEvent,
  fieldMap: GatewayFieldMap = DEFAULT_FIELD_MAP,
): IncomingMessage | null {
  // 防御：raw 在运行时可能是 null / 数组 / 基本类型（伪造帧）。
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const map = fieldMap ?? DEFAULT_FIELD_MAP;

  // ---- 路由必需字段：缺失或非法 -> 丢弃 ----
  const platform = asPlatform(getByPath(raw, map.platform));
  if (platform === null) {
    return null;
  }

  const conversationId = asNonEmptyString(getByPath(raw, map.conversationId));
  if (conversationId === null) {
    return null;
  }

  // messageId 是去重键。没有它就必然重复转发，因此宁可不转发。
  const messageId = asNonEmptyString(getByPath(raw, map.messageId));
  if (messageId === null) {
    return null;
  }

  // 群聊/私聊判定直接影响合规策略，缺失即丢弃，绝不默认 private。
  const chatType = asChatType(getByPath(raw, map.chatType));
  if (chatType === null) {
    return null;
  }

  // ---- 以下字段允许缺省，但只接受白名单内的类型 ----
  const kind = asKind(getByPath(raw, map.kind));

  let text: string | null = null;
  if (kind === "text") {
    const rawText = getByPath(raw, map.text);
    if (typeof rawText !== "string") {
      // 声明是文本却没有正文：契约破损，按 fail-closed 丢弃。
      return null;
    }
    text = rawText;
  }

  const rawSenderId = getByPath(raw, map.senderId);
  const senderId = typeof rawSenderId === "string" ? rawSenderId : "";

  return {
    platform,
    conversationId,
    chatType,
    messageId,
    senderId,
    senderIsSelf: asOptionalBoolean(getByPath(raw, map.senderIsSelf)),
    senderIsBot: asOptionalBoolean(getByPath(raw, map.senderIsBot)),
    kind,
    text,
    receivedAt: asTimestamp(getByPath(raw, map.timestamp)),
  };
}
