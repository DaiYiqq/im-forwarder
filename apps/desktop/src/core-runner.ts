/**
 * 桌面端内嵌核心进程（Electron utilityProcess 入口）。
 *
 * 复用方式：直接 import 仓库核心 ../../../src 的实现，由 esbuild 打包为自包含的
 * dist/core-runner.cjs。命令语义与 `tsx src/main.ts` 完全一致：
 *   读配置 → 合规前置检查（不通过 exit 78）→ 连接网关 → 转发 → 白名单日志。
 *
 * 与父进程（Electron main）的协议：
 *   子 → 父：{type:"status", payload:StatusSnapshot}
 *            {type:"log", record:白名单日志记录}
 *            {type:"fatal", code, exitCode, violations?}
 *   父 → 子：{type:"stop"}
 *
 * 合规边界：
 *   · 日志复用核心 Logger（类型白名单 + 运行期白名单 + 超长占位），本文件不额外打印任何消息内容；
 *   · 配置里的令牌只从环境变量读取，绝不打印、绝不回传；
 *   · 本进程不建立任何平台连接（微信/QQ/Telegram 全部由 EasyBot 网关负责）。
 */

import process from "node:process";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../../src/config/load";
import type { AppConfig } from "../../../src/config/schema";
import { RISK_NOTICE_VERSION } from "../../../src/config/schema";
import { ConsentService } from "../../../src/compliance/consent";
import { ConsentStore, ConsentStoreError } from "../../../src/compliance/consent-store";
import { runPreflight } from "../../../src/compliance/preflight";
import { evaluateCrossBorderGate } from "../../../src/compliance/gates";
import { HttpGatewayClient } from "../../../src/gateway/client";
import { WebSocketEventSource } from "../../../src/gateway/events";
import { toErrorCode } from "../../../src/gateway/errors";
import { Logger, type LogFields } from "../../../src/observability/logger";
import { Forwarder } from "../../../src/pipeline/forward";
import { LoopGuard } from "../../../src/pipeline/loop-guard";
import type { ForwardCounts, StatusSnapshot, Violation } from "./ipc";

/** Electron utilityProcess 在子进程里注入的 process.parentPort。 */
interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

interface ParentMessage {
  type?: unknown;
}

const parentPort: ParentPortLike | undefined = (
  process as unknown as { parentPort?: ParentPortLike }
).parentPort;

const counts: ForwardCounts = { forwarded: 0, failed: 0, skipped: 0 };
let startedAt: number | null = null;
let statusTimer: NodeJS.Timeout | null = null;
let routeCount = 0;
let crossBorderOpen = false;
let gatewayHost = "";
let stopping = false;

function post(message: unknown): void {
  if (!parentPort) return;
  try {
    parentPort.postMessage(message);
  } catch {
    // 父进程已退出/端口关闭：忽略即可，绝不影响转发主流程。
  }
}

function sendStatus(running: boolean): void {
  const snapshot: StatusSnapshot = {
    running,
    startedAt: running ? startedAt : null,
    routeCount,
    gateway: { baseUrlHost: gatewayHost },
    crossBorderOpen,
    counts: { ...counts },
  };
  post({ type: "status", payload: snapshot });
}

/** 转发计数变化后节流上报（最多 5 次/秒），避免高频事件刷屏父进程。 */
function scheduleStatus(): void {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    sendStatus(true);
  }, 200);
  statusTimer.unref?.();
}

function account(record: Record<string, unknown>): void {
  if (record["event"] !== "forward") return;
  const status = record["status"];
  if (typeof status !== "string") return;
  if (status === "forwarded") {
    counts.forwarded += 1;
  } else if (status === "send_failed") {
    counts.failed += 1;
  } else {
    counts.skipped += 1;
  }
}

/**
 * Logger sink：把核心 Logger 产出的 JSON 行转成父进程消息。
 * 核心 Logger 已经按白名单 pick 过，这里只做解析与计数，不再读取任何额外字段。
 */
function sink(line: string): void {
  if (!parentPort) {
    process.stdout.write(`${line}\n`);
    return;
  }
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    record = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  account(record);
  post({ type: "log", record });
  scheduleStatus();
}

function fatal(code: string, exitCode: number, violations?: Violation[]): void {
  post({ type: "fatal", code, exitCode, ...(violations ? { violations } : {}) });
  if (!parentPort) {
    process.stderr.write(`[fatal] ${code}\n`);
  }
  // 给父进程一点时间接收消息，然后退出（退出码与核心 CLI 保持一致）。
  setTimeout(() => process.exit(exitCode), 100).unref?.();
  setTimeout(() => process.exit(exitCode), 1000);
}

function toViolations(
  list: ReadonlyArray<{ code: string; message: string; hint: string; routeId?: string }>,
): Violation[] {
  return list.map((item) => ({
    code: item.code,
    message: item.message,
    ...(item.hint ? { hint: item.hint } : {}),
    ...(item.routeId ? { routeId: item.routeId } : {}),
  }));
}

async function main(): Promise<void> {
  const configPath = process.env["IM_CONFIG_PATH"] ?? process.argv[2] ?? "";
  if (!configPath) {
    fatal("CONFIG_PATH_MISSING", 78);
    return;
  }
  // 桌面端把 userData 作为 cwd 传入：配置里的相对 dataDir 会落在 userData 下，
  // 而不是安装目录（Program Files 通常不可写）。命令行独立运行时保持默认 cwd。
  const cwd = process.env["IM_CWD"];

  let config: AppConfig;
  try {
    config = loadConfig({ configPath, env: process.env, ...(cwd ? { cwd } : {}) });
  } catch (error) {
    if (error instanceof ConfigError) {
      fatal("CONFIG_INVALID", 78, [
        {
          code: error.code,
          message: error.message,
          ...(error.details.length > 0 ? { hint: error.details.join("\n") } : {}),
        },
      ]);
      return;
    }
    if (error instanceof ConsentStoreError) {
      fatal("CONSENT_STORE_CORRUPT", 78, [{ code: error.code, message: error.message }]);
      return;
    }
    fatal(toErrorCode(error), 1);
    return;
  }

  const report = runPreflight({ config, env: process.env });
  if (!report.ok) {
    fatal("COMPLIANCE_PREFLIGHT_FAILED", 78, toViolations(report.violations));
    return;
  }
  const matrix = report.matrix;
  if (!matrix) {
    fatal("ROUTE_MATRIX_INVALID", 78);
    return;
  }

  routeCount = matrix.stats.routes;
  try {
    gatewayHost = new URL(config.gateway.baseUrl).host;
  } catch {
    gatewayHost = "";
  }
  crossBorderOpen = evaluateCrossBorderGate(
    config.compliance.telegramCrossBorder,
    RISK_NOTICE_VERSION,
  ).open;

  const logger = new Logger({ level: config.compliance.logLevel, sink });

  // 同意记录：损坏时 fail-closed（绝不带着未知的同意状态开始转发）。
  let consentService: ConsentService | null = null;
  if (config.compliance.thirdPartyConsent.enabled) {
    const consentPath = join(config.dataDir, "consent.json");
    const store = config.compliance.thirdPartyConsent.persist
      ? ConsentStore.fromFile(consentPath)
      : ConsentStore.inMemory();
    consentService = new ConsentService(store, config.compliance.thirdPartyConsent);
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

  const forwarder = new Forwarder({
    config,
    matrix,
    gateway: client,
    consent: consentService,
    loopGuard,
    logger,
    crossBorderOpen,
  });

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
      logger.error({ event: "handler_error", errorCode: toErrorCode(error) } satisfies LogFields);
    });
  });

  startedAt = Date.now();
  logger.info({ event: "startup", status: "listening", count: matrix.stats.routes });
  sendStatus(true);

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ event: "shutdown", status: signal });
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    sendStatus(false);
    const failSafe = setTimeout(() => process.exit(0), 4000);
    failSafe.unref?.();
    try {
      await events.stop();
    } catch {
      // 关闭失败不影响退出码。
    }
    process.exit(0);
  };

  parentPort?.on("message", (event) => {
    const data = event?.data as ParentMessage | undefined;
    if (data && data.type === "stop") {
      void shutdown("parent");
    }
  });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 兜底：任何未捕获异常都只上报稳定错误码，绝不把 message 原文（可能含正文）发出去。
  process.on("uncaughtException", () => {
    fatal("UNCAUGHT_EXCEPTION", 1);
  });
  process.on("unhandledRejection", () => {
    fatal("UNHANDLED_REJECTION", 1);
  });
}

main().catch((error: unknown) => {
  fatal(toErrorCode(error), 1);
});
