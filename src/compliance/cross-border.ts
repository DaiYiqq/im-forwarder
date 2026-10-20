/**
 * 数据出境（《个人信息保护法》第三十八条、第三十九条）对应的代码侧设施。
 *
 * 这里只做两件事：
 *  1. 提供"出境风险告知"的固定文案（启动横幅、同意提示复用同一份，避免文案漂移）；
 *  2. 提供启动阻断判定（preflight 使用）。
 *
 * 本服务**不可能**替使用者完成第五十五条要求的出境前置程序
 * （安全评估 / 标准合同 / 个人信息保护认证），也不会假装完成。
 * 因此：出境路由默认关闭；开启只是"使用者自担责任 + 留痕"，不是合规证明。
 */

import type { ComplianceSettings, RouteConfig } from "../config/schema";
import { evaluateCrossBorderGate, isCrossBorderEdge } from "./gates";

/** 出境风险告知（第三十八条/第三十九条：告知 + 单独同意）。 */
export const CROSS_BORDER_RISK_NOTICE: readonly string[] = [
  "Telegram 的服务器位于境外。从微信/QQ 转发消息到 Telegram，",
  "可能构成《个人信息保护法》第三十八条所称的「向境外提供个人信息」。",
  "开启前请自行确认：",
  "  · 已完成第三十八条要求的出境路径之一（安全评估 / 标准合同 / 保护认证），或属于法定豁免情形；",
  "  · 已按第三十九条向本人（或他人）明确告知境外接收方名称、联系方式、处理目的、处理方式、",
  "    个人信息种类以及行使权利的方式，并取得单独同意；",
  "  · 仅转发本人自己的消息，不转发他人聊天内容（除非已单独取得该他人的单独同意）。",
  "本工具不提供、也不代为完成上述任何法定程序，不对使用者的出境行为合法性作出任何保证。",
];

export interface CrossBorderBanner {
  /** 出境边数量（目标平台为 telegram 的路由数） */
  outboundEdges: number;
  /** 入境边数量（源平台为 telegram 的路由数；不构成"出境"） */
  inboundEdges: number;
  gateOpen: boolean;
  reasons: string[];
}

export function buildCrossBorderBanner(
  settings: ComplianceSettings["telegramCrossBorder"],
  routes: readonly RouteConfig[],
  expectedNoticeVersion: string,
): CrossBorderBanner {
  const gate = evaluateCrossBorderGate(settings, expectedNoticeVersion);
  const outboundEdges = routes.filter((route) => isCrossBorderEdge(route)).length;
  const inboundEdges = routes.filter((route) => route.from.platform === "telegram").length;
  return { outboundEdges, inboundEdges, gateOpen: gate.open, reasons: gate.reasons };
}

export interface CrossBorderStartupBlockerInfo {
  code: "CROSS_BORDER_GATE_CLOSED" | "CROSS_BORDER_ACK_INCOMPLETE";
  lines: string[];
}

/**
 * 出境路由的启动阻断判定：存在出境边而闸门未开 ⇒ 返回阻断信息；否则 null。
 *
 * 代码选择 `CROSS_BORDER_GATE_CLOSED`（完全没开）与 `CROSS_BORDER_ACK_INCOMPLETE`
 * （开了但确认不全）两种错误码，便于使用者定位是"忘了开"还是"填了一半"。
 */
export function crossBorderStartupBlocker(
  settings: ComplianceSettings["telegramCrossBorder"],
  routes: readonly RouteConfig[],
  expectedNoticeVersion: string,
): CrossBorderStartupBlockerInfo | null {
  const outbound = routes.filter((route) => isCrossBorderEdge(route));
  if (outbound.length === 0) return null;

  const gate = evaluateCrossBorderGate(settings, expectedNoticeVersion);
  if (gate.open) return null;

  return {
    code: settings.enabled ? "CROSS_BORDER_ACK_INCOMPLETE" : "CROSS_BORDER_GATE_CLOSED",
    lines: [
      `检测到 ${outbound.length} 条目标平台为 Telegram 的出境路由（${outbound
        .map((route) => route.id)
        .join(", ")}），但出境闸门未完全打开。具体原因：`,
      ...gate.reasons.map((reason) => `  - ${reason}`),
      "注意：本工具不代为完成 PIPL 第 38 条要求的出境路径与第 39 条的告知/单独同意。",
    ],
  };
}
