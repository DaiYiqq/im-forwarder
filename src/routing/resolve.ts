/**
 * 运行时路由解析：把一条归一化消息映射到它命中的路由列表。
 *
 * 匹配键同时包含 platform / conversationId / chatType，
 * 因此"微信私聊"与"微信群聊"在路由层就是两个不同的节点 —— 物理隔离。
 */

import { endpointKey } from "../compliance/gates";
import type { IncomingMessage } from "../types";
import type { CompiledMatrix, CompiledRoute } from "./matrix";

export function sourceKeyOf(message: Pick<IncomingMessage, "platform" | "conversationId" | "chatType">): string {
  return endpointKey(message);
}

export function resolveRoutes(
  matrix: CompiledMatrix,
  message: Pick<IncomingMessage, "platform" | "conversationId" | "chatType">,
): CompiledRoute[] {
  return matrix.bySource.get(sourceKeyOf(message)) ?? [];
}
