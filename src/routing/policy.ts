/**
 * 运行时策略链。
 *
 * 顺序固定、fail-closed，任何一步不确定都往"不转发"方向走：
 *
 *   0. 自消息 / 机器人消息        → 丢弃（防 bot 互踢）
 *   1. 微信非私聊                → 丢弃（硬编码，不可配置）
 *   2. 无路由                    → 忽略
 *   3. 回显（回环 ID 层）        → 丢弃 / 受 hop 预算约束
 *   4. 非文本类型                → 显式回执 + 跳过（不静默丢弃）
 *   5. 出境边且闸门未开          → 阻断（前置检查已拦，此处兜底）
 *   6. 短期指纹回环              → 丢弃
 *   7. 他人内容且缺同意          → 发告知 + 阻断
 *   8. 放行
 */

import type { AppConfig } from "../config/schema";
import type { ConsentScope, ConsentService } from "../compliance/consent";
import { endpointKey } from "../compliance/gates";
import { SUPPORTED_KINDS, type ForwardStatus, type IncomingMessage } from "../types";
import type { LoopGuard } from "../pipeline/loop-guard";
import type { CompiledMatrix, CompiledRoute } from "./matrix";
import { resolveRoutes } from "./resolve";

export type PolicyDecision =
  | { action: "drop"; status: ForwardStatus; routeId: string | null }
  | { action: "forward"; route: CompiledRoute; hop: number }
  | {
      action: "notice";
      /** 回执类型：不支持的类型 / 等待同意 */
      reason: "unsupported-kind" | "consent-pending";
      status: ForwardStatus;
      route: CompiledRoute;
      missing: ConsentScope[];
    };

export interface PolicyContext {
  config: AppConfig;
  loopGuard: LoopGuard;
  consent: ConsentService | null;
  /** 出境闸门在启动时求值一次；配置不可热更新，所以运行时视为常量。 */
  crossBorderOpen: boolean;
}

export function decideAll(
  message: IncomingMessage,
  matrix: CompiledMatrix,
  context: PolicyContext,
): PolicyDecision[] {
  // 0. 自身/机器人消息：不参与转发，避免与其它 bot 形成互踢循环
  if (message.senderIsSelf) {
    return [{ action: "drop", status: "skipped_self", routeId: null }];
  }
  if (message.senderIsBot) {
    return [{ action: "drop", status: "skipped_bot", routeId: null }];
  }

  // 1. 群聊硬门（任何平台）：与配置无关，运行期兜底。
  //    微信是绝对红线；其它平台的群聊同样不支持，因为群内无法逐一取得成员同意。
  if (message.chatType !== "private") {
    return [{ action: "drop", status: "skipped_group_forbidden", routeId: null }];
  }

  // 2. 路由命中
  const routes = resolveRoutes(matrix, message);
  if (routes.length === 0) {
    return [{ action: "drop", status: "skipped_no_route", routeId: null }];
  }

  // 3. 回显层
  const echo = context.loopGuard.lookupEcho(message);
  const decisions: PolicyDecision[] = [];
  let hop = 0;

  if (echo.kind === "echo") {
    const nextHop = echo.hop + 1;
    if (nextHop > context.config.compliance.loopGuard.maxHops) {
      return [{ action: "drop", status: "skipped_loop_suspected", routeId: null }];
    }
    hop = nextHop;
    context.loopGuard.consumeEcho(message);
  }

  for (const route of routes) {
    if (echo.kind === "echo" && echo.group !== route.group) {
      // 回显来自另一个 group：不做跨 group 传播，直接阻断（配置问题在编译期已拦）
      decisions.push({ action: "drop", status: "skipped_loop_suspected", routeId: route.id });
      continue;
    }

    // 4. 消息类型白名单：只做文本；其它类型显式回执
    if (!SUPPORTED_KINDS.includes(message.kind)) {
      decisions.push({
        action: "notice",
        reason: "unsupported-kind",
        status: "skipped_unsupported_kind",
        route,
        missing: [],
      });
      continue;
    }

    // 5. 出境边兜底
    if (route.crossBorder && !context.crossBorderOpen) {
      decisions.push({ action: "drop", status: "blocked_cross_border", routeId: route.id });
      continue;
    }

    // 6. 短期指纹回环
    if (context.loopGuard.isFingerprintLoop(route.group, message)) {
      decisions.push({ action: "drop", status: "skipped_loop_suspected", routeId: route.id });
      continue;
    }

    // 7. 他人内容：告知—同意
    if (route.contentOwner === "third-party") {
      const consent = context.consent;
      const check = consent
        ? consent.check(message, route)
        : { allowed: false, missing: ["domestic" as ConsentScope] };
      if (!check.allowed) {
        decisions.push({
          action: "notice",
          reason: "consent-pending",
          status: "blocked_consent_pending",
          route,
          missing: check.missing,
        });
        continue;
      }
    }

    // 8. 放行
    decisions.push({ action: "forward", route, hop });
  }

  return decisions;
}

/** 供日志/诊断：把消息压成不含正文的定位信息。 */
export function describeSource(message: IncomingMessage): string {
  return endpointKey(message);
}
