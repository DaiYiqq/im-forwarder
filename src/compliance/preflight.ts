/**
 * 运行时前置检查（合规硬闸）。
 *
 * 需求原文：若配置开启了"转发他人消息"或"Telegram 出境路由"而对应确认开关未开启，
 * 进程必须拒绝启动并打印合规提示。本文件就是那道闸门。
 *
 * 原则：
 *  · 宁可启动失败，也不带着不确定的合规状态运行；
 *  · 每条违规都给出「为什么」和「怎么改」，而不是一句"配置错误"；
 *  · 没有任何 --force / --skip-check 之类的绕过开关（这是刻意的）。
 */

import { accessSync, constants, mkdirSync } from "node:fs";
import type { AppConfig } from "../config/schema";
import { RISK_NOTICE_VERSION } from "../config/schema";
import {
  checkRouteShape,
  directPlatformHostViolation,
  evaluateCrossBorderGate,
  isCrossBorderEdge,
  isThirdPartyRoute,
} from "./gates";
import { crossBorderStartupBlocker } from "./cross-border";
import { compileMatrix, RouteMatrixError, type CompiledMatrix } from "../routing/matrix";

export interface ComplianceViolation {
  code: string;
  message: string;
  hint: string;
  routeId?: string;
}

export interface PreflightReport {
  ok: boolean;
  violations: ComplianceViolation[];
  banner: string[];
  matrix: CompiledMatrix | null;
}

export interface PreflightOptions {
  config: AppConfig;
  env?: NodeJS.ProcessEnv;
}

export class ComplianceHalt extends Error {
  readonly code = "COMPLIANCE_PREFLIGHT_FAILED";
  readonly exitCode = 78;
  readonly violations: ComplianceViolation[];

  constructor(report: PreflightReport) {
    super(`合规前置检查未通过（${report.violations.length} 项），进程拒绝启动`);
    this.name = "ComplianceHalt";
    this.violations = report.violations;
  }
}

export function runPreflight(options: PreflightOptions): PreflightReport {
  const { config } = options;
  const env = options.env ?? process.env;
  const violations: ComplianceViolation[] = [];

  // ── 1. 路由结构（含微信私聊硬门）──────────────────────────────────────────
  for (const route of config.routes) {
    for (const shapeViolation of checkRouteShape(route)) {
      violations.push({
        code: shapeViolation.code,
        message: shapeViolation.message,
        hint: shapeViolation.hint,
        routeId: shapeViolation.routeId,
      });
    }
  }

  // ── 2. 出境闸门（PIPL 第 38/39 条）────────────────────────────────────────
  const crossBorderBlocker = crossBorderStartupBlocker(
    config.compliance.telegramCrossBorder,
    config.routes,
    RISK_NOTICE_VERSION,
  );
  if (crossBorderBlocker) {
    violations.push({
      code: crossBorderBlocker.code,
      message: crossBorderBlocker.lines.join("\n"),
      hint:
        "二选一：\n" +
        "  A. 删除/注释掉所有 Telegram 目标路由（推荐，默认配置即如此）；\n" +
        "  B. 若确需开启：设置 enabled=true、operator=<署名>、" +
        "acknowledgedAt=<ISO8601>、selfMessagesOnlyConfirmed=true，" +
        "并已自行完成 PIPL 第 38 条要求的出境路径与第 39 条的告知/单独同意。\n" +
        "  详见 COMPLIANCE.md「第三十八条 / 第三十九条」与 docs/OPERATIONS.md。",
    });
  }

  // ── 3. 他人内容同意机制（PIPL 第 23 条）──────────────────────────────────
  const thirdPartyRoutes = config.routes.filter((route) => isThirdPartyRoute(route));
  for (const route of thirdPartyRoutes) {
    if (!config.compliance.thirdPartyConsent.enabled) {
      violations.push({
        code: "THIRD_PARTY_CONSENT_DISABLED",
        message:
          `路由 ${route.id} 声明 contentOwner=third-party（转发他人聊天内容），` +
          "但 compliance.thirdPartyConsent.enabled = false",
        hint:
          "本项目不允许默认开放他人内容的转发。二选一：\n" +
          "  A. 把路由改为 contentOwner=self（仅限你与自己其他账号之间的消息）；\n" +
          "  B. 显式开启 thirdPartyConsent.enabled=true，并为每个目标补齐告知要素（receiver.*）。",
        routeId: route.id,
      });
    }

    for (const target of route.to) {
      if (!target.receiver) {
        violations.push({
          code: "THIRD_PARTY_NOTICE_MISSING",
          message:
            `路由 ${route.id} 的目标 ${target.platform}:${target.conversationId} 缺少告知要素（receiver）`,
          hint:
            "PIPL 第 23 条要求告知接收方名称、联系方式、处理目的、处理方式、信息种类。" +
            "请在目标配置中补齐 receiver.name / contact / purpose / method / dataCategories / retention。",
          routeId: route.id,
        });
      }
    }

    if (isCrossBorderEdge(route) && !config.compliance.thirdPartyConsent.allowCrossBorder) {
      violations.push({
        code: "THIRD_PARTY_CROSS_BORDER_FORBIDDEN",
        message:
          `路由 ${route.id} 同时构成"他人内容"与"数据出境"，但 ` +
          "compliance.thirdPartyConsent.allowCrossBorder = false",
        hint:
          "他人内容出境需要同时满足第 23 条（单独同意）与第 39 条（出境单独同意），" +
          "本项目的同意流程只覆盖自己与自己账号之间的消息。" +
          "若确需开启，请自行完成全部法定程序后再显式设置 allowCrossBorder=true。",
        routeId: route.id,
      });
    }
  }

  // ── 4. 禁止直连平台（绕过网关 = 绕过官方 iLink 通道）────────────────────
  for (const [field, url] of [
    ["gateway.baseUrl", config.gateway.baseUrl],
    ["gateway.eventsUrl", config.gateway.eventsUrl],
  ] as const) {
    const violation = directPlatformHostViolation(url);
    if (violation) {
      violations.push({
        code: "DIRECT_PLATFORM_ENDPOINT",
        message: `${field} 指向平台官方域名 ${violation.host}`,
        hint:
          `${violation.reason}。请把 ${field} 指向 EasyBot 网关地址（例如 http://127.0.0.1:18080）。` +
          "本服务不负责任何平台的登录、鉴权与协议连接。",
      });
    }
  }

  // ── 5. 网关令牌（只从环境变量读取）──────────────────────────────────────
  const token = env[config.gateway.tokenEnv];
  if (!token || token.trim().length === 0) {
    violations.push({
      code: "GATEWAY_TOKEN_MISSING",
      message: `环境变量 ${config.gateway.tokenEnv} 未设置或为空`,
      hint:
        `设置方式（PowerShell）：$env:${config.gateway.tokenEnv}="<网关令牌>"；` +
        "禁止把令牌写进配置文件或提交到仓库。",
    });
  }

  // ── 6. 同意记录目录 ─────────────────────────────────────────────────────
  if (config.compliance.thirdPartyConsent.persist && config.compliance.thirdPartyConsent.enabled) {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      accessSync(config.dataDir, constants.W_OK);
    } catch (error) {
      violations.push({
        code: "DATA_DIR_UNWRITABLE",
        message: `同意记录目录不可写：${config.dataDir}（${String((error as Error).message)}）`,
        hint:
          "同意记录不落盘就无法证明「告知—同意」已发生。请修正目录权限，" +
          "或显式设置 thirdPartyConsent.persist=false（此时同意仅在内存中有效，重启即失效）。",
      });
    }
  }

  // ── 7. 路由矩阵编译（重复 id / 重复边 / 自环 / 跨 group 环）─────────────
  // 形状检查（群聊/自环）已在第 1 步带完整整改建议做过一遍，这里传 checkShape:false 避免重复上报。
  let matrix: CompiledMatrix | null = null;
  try {
    matrix = compileMatrix(config.routes, { checkShape: false });
  } catch (error) {
    if (error instanceof RouteMatrixError) {
      for (const issue of error.issues) {
        violations.push({
          code: issue.code,
          message: issue.message,
          hint: "修正配置中的路由定义后重试；本项目不对路由冲突做自动取舍。",
          ...(issue.routeId ? { routeId: issue.routeId } : {}),
        });
      }
    } else {
      violations.push({
        code: "ROUTE_MATRIX_INVALID",
        message: String((error as Error).message),
        hint: "检查 routes 配置。",
      });
    }
  }

  // ── 8. 回环防护：存在环时不允许关闭防护 ─────────────────────────────────
  if (matrix && matrix.cycles.length > 0 && !config.compliance.loopGuard.enabled) {
    violations.push({
      code: "LOOP_GUARD_REQUIRED",
      message:
        `路由矩阵中存在 ${matrix.cycles.length} 个环（${matrix.cycles
          .map((cycle) => cycle.nodes.join(" → "))
          .join("；")}），但 compliance.loopGuard.enabled = false`,
      hint:
        "双向路由（如 微信 ↔ QQ）天然构成环。必须保持 loopGuard.enabled=true，" +
        "否则消息会在两个平台之间无限循环。",
    });
  }

  const banner: string[] = [];
  if (matrix) {
    const gate = evaluateCrossBorderGate(config.compliance.telegramCrossBorder, RISK_NOTICE_VERSION);
    // 平台定性说明（对应需求：必须在代码注释与 README 中标注各平台的性质与风险）：
    //  · 微信：只能经由 EasyBot 网关的官方 iLink(ClawBot) 通道，本服务不含任何登录代码，
    //    且只处理私聊；
    //  · QQ：NapCat 不是 QQ 官方机器人通道。通过它登录个人号存在登录验证、掉线、封号风险，
    //    必须使用专门小号，严禁主力账号。本服务不提供任何规避风控的手段；
    //  · Telegram：只能使用官方 Bot API（BotFather 机器人）。严禁 MTProto userbot /
    //    Telethon / Pyrogram 等以个人号身份登录的方案。
    banner.push(
      "[COMPLIANCE] wechat   = 官方 iLink(ClawBot) · 仅私聊 · 经网关 | 本服务不含任何微信登录代码",
    );
    banner.push(
      "[COMPLIANCE] qq       = NapCat + OneBot11 经网关 | 非官方通道 · 有登录验证/掉线/封号风险 · 必须用小号",
    );
    banner.push(
      `[COMPLIANCE] telegram = 官方 Bot API 经网关 | 出境闸门：${gate.open ? "OPEN" : "CLOSED"}` +
        (gate.open ? ` · 开通者：${config.compliance.telegramCrossBorder.operator ?? "(未署名)"}` : ""),
    );
    banner.push(
      `[COMPLIANCE] routes=${matrix.stats.routes} edges=${matrix.stats.edges} groups=${matrix.stats.groups}` +
        ` | 出境边=${matrix.stats.crossBorderEdges} 入境边=${matrix.stats.inboundTelegramEdges}` +
        ` | 他人内容路由=${matrix.stats.thirdPartyRoutes} | 路由环=${matrix.cycles.length}`,
    );
    banner.push(
      `[COMPLIANCE] 正文持久化：禁止（无数据库/无队列/无磁盘缓存） | 正文日志：禁止（日志字段白名单）` +
        ` | 同意记录：${config.compliance.thirdPartyConsent.enabled ? `${config.dataDir}${config.compliance.thirdPartyConsent.persist ? "/consent.json" : "（仅内存）"}` : "未启用"}`,
    );
  }

  return { ok: violations.length === 0 && matrix !== null, violations, banner, matrix };
}

export function assertPreflight(options: PreflightOptions): PreflightReport {
  const report = runPreflight(options);
  if (!report.ok) {
    throw new ComplianceHalt(report);
  }
  return report;
}

export function formatPreflightFailure(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("════════════════════════════════════════════════════════════════");
  lines.push("  合规前置检查未通过 —— 进程拒绝启动（exit code 78）");
  lines.push("════════════════════════════════════════════════════════════════");
  report.violations.forEach((violation, index) => {
    lines.push("");
    lines.push(`[${index + 1}] ${violation.code}${violation.routeId ? `（路由 ${violation.routeId}）` : ""}`);
    lines.push(`    问题：${violation.message}`);
    lines.push(`    建议：${violation.hint}`);
  });
  lines.push("");
  lines.push("前提示：本项目的合规约束优先于功能需求。");
  lines.push("本项目不提供 --force / --skip-compliance 之类的绕过开关。");
  lines.push("相关条款与代码位置对照见 COMPLIANCE.md。");
  lines.push("");
  return lines.join("\n");
}
