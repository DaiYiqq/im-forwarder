/**
 * 进程入口。
 *
 * 启动顺序是刻意的：
 *   1. 读配置（含危险键扫描 + strict schema）
 *   2. 合规前置检查（不通过 → exit 78，且没有任何绕过开关）
 *   3. 打印合规横幅（可截图留证）
 *   4. 编译路由矩阵
 *   5. 订阅网关事件 → 交给 Forwarder
 *
 * 本文件不建立任何平台连接：微信/QQ/Telegram 的连接全部由 EasyBot 网关负责。
 */

import process from "node:process";
import { join } from "node:path";
import { ConfigError, describeConfig, loadConfig } from "./config/load";
import type { AppConfig } from "./config/schema";
import { RISK_NOTICE_VERSION } from "./config/schema";
import { ConsentService } from "./compliance/consent";
import { ConsentStore, ConsentStoreError } from "./compliance/consent-store";
import {
  ComplianceHalt,
  formatPreflightFailure,
  runPreflight,
  type PreflightReport,
} from "./compliance/preflight";
import {
  CROSS_BORDER_RISK_NOTICE,
  buildCrossBorderBanner,
} from "./compliance/cross-border";
import { evaluateCrossBorderGate } from "./compliance/gates";
import { HttpGatewayClient } from "./gateway/client";
import { WebSocketEventSource } from "./gateway/events";
import { toErrorCode } from "./gateway/errors";
import { Logger } from "./observability/logger";
import { Forwarder } from "./pipeline/forward";
import { LoopGuard } from "./pipeline/loop-guard";

const EXIT_COMPLIANCE = 78;

interface CliOptions {
  configPath: string;
  /** 只做配置与合规检查，然后退出（用于部署前自检 / CI） */
  selfCheck: boolean;
}

function parseArgs(args: string[]): CliOptions {
  let configPath = "config/config.yaml";
  let selfCheck = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      const next = args[index + 1];
      if (!next) throw new Error("--config 需要一个文件路径");
      configPath = next;
      index += 1;
    } else if (arg === "--self-check") {
      selfCheck = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "用法：tsx src/main.ts [--config <path>] [--self-check]",
          "",
          "  --config <path>  配置文件路径（默认 config/config.yaml）",
          "  --self-check     仅执行配置校验与合规前置检查，然后退出",
          "",
          "退出码：0=正常  78=配置/合规检查未通过  1=运行期错误",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { configPath, selfCheck };
}

function writeBanner(lines: readonly string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  let config: AppConfig;

  try {
    config = loadConfig({ configPath: options.configPath, env: process.env });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n配置错误（${error.code}）：${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`  - ${detail}\n`);
      process.stderr.write("\n");
      return EXIT_COMPLIANCE;
    }
    if (error instanceof ConsentStoreError) {
      process.stderr.write(`\n同意记录异常（${error.code}）：${error.message}\n\n`);
      return EXIT_COMPLIANCE;
    }
    throw error;
  }

  const report: PreflightReport = runPreflight({ config, env: process.env });
  if (!report.ok) {
    process.stderr.write(formatPreflightFailure(report));
    return EXIT_COMPLIANCE;
  }

  const matrix = report.matrix;
  if (!matrix) {
    process.stderr.write("内部错误：前置检查通过但没有编译出路由矩阵。\n");
    return EXIT_COMPLIANCE;
  }

  const logger = new Logger({ level: config.compliance.logLevel });

  writeBanner([
    "──────────────────────────────────────────────────────────────",
    " im-forwarder · 微信(iLink) ↔ QQ(NapCat) ↔ Telegram(Bot API)",
    " 仅供技术研究学习 · 禁止商业用途 / 收费服务 / 付费托管",
    "──────────────────────────────────────────────────────────────",
    ...report.banner,
    "──────────────────────────────────────────────────────────────",
  ]);

  const crossBorder = buildCrossBorderBanner(
    config.compliance.telegramCrossBorder,
    config.routes,
    RISK_NOTICE_VERSION,
  );
  if (crossBorder.outboundEdges > 0) {
    writeBanner([
      "",
      `[数据出境] 本次启动启用 ${crossBorder.outboundEdges} 条出境路由，闸门：${crossBorder.gateOpen ? "OPEN" : "CLOSED"}。`,
      ...CROSS_BORDER_RISK_NOTICE.map((line) => `  ${line}`),
      "",
    ]);
  }

  // 同意记录：损坏时 fail-closed（宁可起不来，也不要"不知道谁同意过"就开始转发）
  let consentService: ConsentService | null = null;
  if (config.compliance.thirdPartyConsent.enabled) {
    const consentPath = join(config.dataDir, "consent.json");
    const store = config.compliance.thirdPartyConsent.persist
      ? ConsentStore.fromFile(consentPath)
      : ConsentStore.inMemory();
    consentService = new ConsentService(store, config.compliance.thirdPartyConsent);
    writeBanner([
      `[CONSENT] 同意记录：${config.compliance.thirdPartyConsent.persist ? consentPath : "仅内存（重启失效）"}` +
        `（已记录 ${store.size()} 条，仅元数据，无聊天正文）`,
    ]);
  }

  const token = process.env[config.gateway.tokenEnv] as string;
  const client = new HttpGatewayClient({
    baseUrl: config.gateway.baseUrl,
    sendPath: config.gateway.sendPath,
    token,
    timeoutMs: config.gateway.requestTimeoutMs,
    maxRetries: config.gateway.maxRetries,
    onDiagnostic: (code, info) => {
      logger.warn({
        event: "gateway",
        status: code,
        errorCode: info?.["status"] !== undefined ? String(info["status"]) : undefined,
        attempt: typeof info?.["attempt"] === "number" ? info["attempt"] : undefined,
      });
    },
  });

  const loopGuard = new LoopGuard({
    enabled: config.compliance.loopGuard.enabled,
    echoTtlMs: config.compliance.loopGuard.echoTtlMs,
    fingerprintWindowMs: config.compliance.loopGuard.fingerprintWindowMs,
  });

  const crossBorderOpen = evaluateCrossBorderGate(
    config.compliance.telegramCrossBorder,
    RISK_NOTICE_VERSION,
  ).open;

  const forwarder = new Forwarder({
    config,
    matrix,
    gateway: client,
    consent: consentService,
    loopGuard,
    logger,
    crossBorderOpen,
  });

  if (options.selfCheck) {
    writeBanner([
      "",
      ...describeConfig(options.configPath, config),
      "",
      "自检通过：配置与合规前置检查均未发现问题（未连接网关、未发送任何消息）。",
      "",
    ]);
    return 0;
  }

  const events = new WebSocketEventSource({
    wsUrl: config.gateway.eventsUrl,
    token,
    fieldMap: config.gateway.fieldMap,
    onDiagnostic: (code, info) => {
      logger.warn({
        event: "gateway_events",
        status: code,
        attempt: typeof info?.["attempt"] === "number" ? info["attempt"] : undefined,
      });
    },
  });

  await events.start((message) => {
    void forwarder.handle(message).catch((error: unknown) => {
      logger.error({ event: "handler_error", errorCode: toErrorCode(error) });
    });
  });

  logger.info({ event: "startup", status: "listening", count: matrix.stats.routes });

  return await new Promise<number>((resolve) => {
    const shutdown = (signal: string): void => {
      logger.info({ event: "shutdown", status: signal });
      const timer = setTimeout(() => resolve(0), 5000);
      timer.unref();
      void events
        .stop()
        .catch(() => undefined)
        .finally(() => {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigterm);
          resolve(0);
        });
    };
    const onSigint = (): void => shutdown("SIGINT");
    const onSigterm = (): void => shutdown("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // 只打印错误类型与稳定错误码，绝不打印可能包含消息内容的原始对象
    const code = toErrorCode(error);
    process.stderr.write(`[FATAL] ${code}：${error instanceof Error ? error.name : "UnknownError"}\n`);
    if (error instanceof Error && !(error instanceof ConfigError)) {
      process.stderr.write(`${error.message}\n`);
    }
    process.exit(1);
  });
