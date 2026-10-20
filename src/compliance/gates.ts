/**
 * 合规门闩（纯函数）。
 *
 * 这些函数同时被「启动前置检查」和「运行时策略链」调用：
 * 启动检查保证不会带着违法配置跑起来，运行时再判一次作为纵深防御
 * （例如网关推送了一份绕过配置的事件）。
 */

import type { ComplianceSettings, RouteConfig } from "../config/schema";
import type { EndpointRef, Platform } from "../types";

/**
 * 平台官方域名黑名单。
 *
 * 本服务只允许访问 EasyBot 网关。一旦 gateway.baseUrl 指向平台官方域名，
 * 说明有人试图绕过网关直连平台 —— 微信侧那等于绕开官方 iLink 通道，直接拒绝。
 *
 * 注意：这是"减少误接"的防线，不是安全边界。真正的保证是
 * **本仓库不存在任何平台 SDK / 登录能力**（见 src/gateway/contract.ts 与
 * docs/AUDIT.md 的独立审计结论）。此处做 hostname 规范化以消除
 * "尾随点"（`ilinkai.weixin.qq.com.`）这类等价写法的绕过。
 */
export const PLATFORM_DIRECT_HOST_BLOCKLIST: ReadonlyArray<{ host: string; reason: string }> = [
  {
    host: "ilinkai.weixin.qq.com",
    reason: "微信 iLink(ClawBot) 官方域名：微信能力必须由网关侧官方通道提供，本服务禁止直连",
  },
  {
    host: "weixin.qq.com",
    reason: "微信官方域名：本服务不允许任何形式的微信直连（含网页版/协议逆向）",
  },
  {
    host: "api.telegram.org",
    reason: "Telegram Bot API 官方域名：本服务只调用网关，不直连平台",
  },
  {
    host: "telegram.org",
    reason: "Telegram 官方域名：本服务只调用网关，不直连平台",
  },
];

/**
 * 规范化 hostname：
 *  · 小写（URL 已小写，这里再保证一次）；
 *  · 去掉所有尾随点（`a.example.com.` 与 `a.example.com` 是同一域名的等价写法）；
 *  · 失败返回 null。
 */
export function hostnameOf(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const normalized = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
    return normalized.length === 0 ? null : normalized;
  } catch {
    return null;
  }
}

export function directPlatformHostViolation(rawUrl: string): { host: string; reason: string } | null {
  const host = hostnameOf(rawUrl);
  if (!host) return null;
  for (const entry of PLATFORM_DIRECT_HOST_BLOCKLIST) {
    if (host === entry.host || host.endsWith(`.${entry.host}`)) {
      return { host: entry.host, reason: entry.reason };
    }
  }
  return null;
}

export function endpointKey(endpoint: EndpointRef): string {
  return `${endpoint.platform}:${endpoint.conversationId}:${endpoint.chatType}`;
}

export function sameEndpoint(a: EndpointRef, b: EndpointRef): boolean {
  return (
    a.platform === b.platform &&
    a.conversationId === b.conversationId &&
    a.chatType === b.chatType
  );
}

/** 目标平台是 Telegram ⇒ 数据流向境外 ⇒ 属于 PIPL 第三十八条意义上的"出境"边。 */
export function isCrossBorderEdge(route: RouteConfig): boolean {
  return route.to.some((target) => target.platform === "telegram");
}

export function isThirdPartyRoute(route: RouteConfig): boolean {
  return route.contentOwner === "third-party";
}

export interface CrossBorderGate {
  open: boolean;
  reasons: string[];
}

/**
 * 出境闸门：五要素齐备才放行。
 *  1. enabled
 *  2. operator 非空（谁开通的）
 *  3. acknowledgedAt 是合法 ISO 时间
 *  4. selfMessagesOnlyConfirmed（"仅转发本人消息"确认）
 *  5. riskNoticeVersion 与当前文案版本一致（文案更新后旧确认自动失效）
 */
export function evaluateCrossBorderGate(
  settings: ComplianceSettings["telegramCrossBorder"],
  expectedNoticeVersion: string,
): CrossBorderGate {
  const reasons: string[] = [];

  if (!settings.enabled) {
    reasons.push("compliance.telegramCrossBorder.enabled = false（默认关闭，必须显式开启）");
  }
  if (!settings.operator || settings.operator.trim().length === 0) {
    reasons.push("缺少 compliance.telegramCrossBorder.operator（开通者署名）");
  }
  if (!settings.acknowledgedAt) {
    reasons.push("缺少 compliance.telegramCrossBorder.acknowledgedAt（确认时间戳）");
  } else if (Number.isNaN(Date.parse(settings.acknowledgedAt))) {
    reasons.push("compliance.telegramCrossBorder.acknowledgedAt 不是合法的 ISO 8601 时间");
  }
  if (!settings.selfMessagesOnlyConfirmed) {
    reasons.push(
      "compliance.telegramCrossBorder.selfMessagesOnlyConfirmed = false（必须确认仅转发本人自己的消息）",
    );
  }
  if (settings.riskNoticeVersion !== expectedNoticeVersion) {
    reasons.push(
      `compliance.telegramCrossBorder.riskNoticeVersion = ${settings.riskNoticeVersion}，` +
        `与当前风险告知版本 ${expectedNoticeVersion} 不一致（文案已更新，需重新确认）`,
    );
  }

  return { open: reasons.length === 0, reasons };
}

export interface RouteShapeViolation {
  code: string;
  routeId: string;
  message: string;
  hint: string;
}

/**
 * 路由形状的硬性检查（与具体策略无关的结构性约束）。
 * 与 matrix 编译分开：这里只回答"这条路由合法吗"，不负责建图。
 */
export function checkRouteShape(route: RouteConfig): RouteShapeViolation[] {
  const violations: RouteShapeViolation[] = [];

  // 微信是绝对红线；其它平台群聊同样拒绝，原因是群聊里无法对每位成员单独取得同意
  // （PIPL 第 23 条），所以本项目整体不支持群聊，而不是"只限制微信"。
  if (route.from.chatType === "group") {
    violations.push(
      route.from.platform === "wechat"
        ? {
            code: "WECHAT_GROUP_SOURCE_FORBIDDEN",
            routeId: route.id,
            message: `路由 ${route.id} 的微信源会话类型是 group，本项目只允许 private`,
            hint: "微信侧仅处理私聊消息；群聊消息既不接收也不发送。请把 chatType 改为 private，或删除该路由。",
          }
        : {
            code: "GROUP_CHAT_UNSUPPORTED",
            routeId: route.id,
            message: `路由 ${route.id} 的源会话是群聊（${route.from.platform}）`,
            hint:
              "本项目不支持任何平台的群聊：群内无法对每位成员逐一完成告知—单独同意，" +
              "也无法排除群内其他成员的个人信息。请改用私聊会话。",
          },
    );
  }

  for (const target of route.to) {
    if (target.chatType === "group") {
      violations.push(
        target.platform === "wechat"
          ? {
              code: "WECHAT_GROUP_TARGET_FORBIDDEN",
              routeId: route.id,
              message: `路由 ${route.id} 的微信目标会话类型是 group，本项目只允许 private`,
              hint: "删除该微信群聊目标。本项目不实现任何微信群聊的接收或发送。",
            }
          : {
              code: "GROUP_CHAT_UNSUPPORTED",
              routeId: route.id,
              message: `路由 ${route.id} 的目标会话是群聊（${target.platform}）`,
              hint:
                "本项目不支持任何平台的群聊目标：无法对群成员逐一取得同意，" +
                "也无法保证不向未同意的第三方提供其个人信息。",
            },
      );
    }
  }

  if (route.to.some((target) => sameEndpoint(route.from, target))) {
    violations.push({
      code: "ROUTE_SELF_LOOP",
      routeId: route.id,
      message: `路由 ${route.id} 的目标与源完全相同（自环）`,
      hint: "自环必然造成消息回环，请删除该目标。",
    });
  }

  return violations;
}

/** 仅供类型收窄使用：确保 Platform 联合不会因后续扩展而静默失效。 */
export type SupportedPlatform = Platform;
