/**
 * 测试公共脚手架。
 *
 * 只被 `test/*.spec.ts` 与 `test/fixtures/*.ts` 引用，不属于产品代码。
 *
 * 设计约束（与任务书一致）：
 *  - 测试必须确定性：不依赖真实网络、不依赖系统当前时间（必要时注入 now）、
 *    端口一律用 0 由内核分配。
 *  - 配置尽量走真实链路（YAML → loadConfig → runPreflight），而不是手搓 AppConfig，
 *    这样"配置入口的合规行为"本身也被覆盖。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";

import type { ConsentService } from "../../src/compliance/consent";
import { loadConfig } from "../../src/config/load";
import {
  normalizeConfig,
  rawConfigSchema,
  type AppConfig,
  type ReceiverNotice,
  type RouteConfig,
  type RouteTarget,
} from "../../src/config/schema";
import { runPreflight, type PreflightReport } from "../../src/compliance/preflight";
import type { GatewayClient, GatewaySendRequest } from "../../src/gateway/contract";
import { Logger, type LogLevel } from "../../src/observability/logger";
import { Forwarder } from "../../src/pipeline/forward";
import { LoopGuard, type LoopGuardOptions } from "../../src/pipeline/loop-guard";
import type { PolicyContext } from "../../src/routing/policy";
import { compileMatrix, type CompiledMatrix } from "../../src/routing/matrix";
import type {
  ChatType,
  EndpointRef,
  IncomingMessage,
  MessageKind,
  Platform,
  SendOutcome,
} from "../../src/types";

/** 仓库根目录（不依赖 process.cwd()，保证从任何目录单跑都成立）。 */
export const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 测试用网关令牌：只从环境变量读取，配置文件里只写环境变量名。 */
export const TEST_TOKEN_ENV = "EASYBOT_TOKEN";
export const TEST_TOKEN = "test-gateway-token";
export const TEST_ENV: NodeJS.ProcessEnv = { [TEST_TOKEN_ENV]: TEST_TOKEN };

/** 固定时钟：让 TTL / 指纹窗口 / 回环窗口的断言不受机器时间影响。 */
export const FIXED_NOW = 1_700_000_000_000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 创建一个一次性临时目录（调用方不需要清理，位于系统临时目录下）。 */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `imf-${prefix}-`));
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置构造
// ─────────────────────────────────────────────────────────────────────────────

export function endpoint(
  platform: Platform,
  conversationId: string,
  chatType: ChatType = "private",
): EndpointRef {
  return { platform, conversationId, chatType };
}

export function target(
  platform: Platform,
  conversationId: string,
  chatType: ChatType = "private",
  receiver?: ReceiverNotice,
): RouteTarget {
  return { platform, conversationId, chatType, ...(receiver ? { receiver } : {}) };
}

/** PIPL 第 23 条要求的完整告知要素（测试用的占位内容）。 */
export function receiverNotice(overrides: Partial<ReceiverNotice> = {}): ReceiverNotice {
  return {
    name: "测试接收方",
    contact: "test@example.invalid",
    purpose: "个人自用消息同步（测试）",
    method: "通过 EasyBot 网关发送纯文本",
    dataCategories: ["文本消息内容", "发送平台标识"],
    retention: "不保存正文，仅内存转发",
    ...overrides,
  };
}

export interface RouteInput {
  id: string;
  from: EndpointRef;
  to: RouteTarget[];
  group?: string;
  contentOwner?: "self" | "third-party";
}

export function route(input: RouteInput): RouteConfig {
  return {
    id: input.id,
    group: input.group ?? input.id,
    contentOwner: input.contentOwner ?? "self",
    from: { ...input.from },
    to: input.to.map((item) => ({ ...item })),
  };
}

export interface RawConfigOptions {
  gateway?: Record<string, unknown>;
  compliance?: Record<string, unknown>;
  /** 顶层附加字段（用于测试未知字段 / 危险键等非法配置）。 */
  extra?: Record<string, unknown>;
}

/** 构造一份"默认即最保守"的原始配置对象（尚未 schema 校验）。 */
export function rawConfig(
  routes: readonly RouteConfig[],
  options: RawConfigOptions = {},
): Record<string, unknown> {
  return {
    version: 1,
    gateway: {
      baseUrl: "http://127.0.0.1:18080",
      eventsUrl: "ws://127.0.0.1:18080/ws/events",
      tokenEnv: TEST_TOKEN_ENV,
      ...(options.gateway ?? {}),
    },
    ...(options.compliance !== undefined ? { compliance: options.compliance } : {}),
    routes: routes.map((item) => JSON.parse(JSON.stringify(item)) as unknown),
    ...(options.extra ?? {}),
  };
}

export interface WrittenConfig {
  configPath: string;
  dataDir: string;
  dir: string;
}

/** 把原始配置写成临时 YAML 文件（dataDir 指向同一临时目录下的 data/）。 */
export function writeRawConfig(raw: Record<string, unknown>, prefix = "config"): WrittenConfig {
  const dir = tempDir(prefix);
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `${stringifyYaml(raw, { lineWidth: 0 })}\n`, "utf8");
  return { configPath, dataDir, dir };
}

/** 走真实配置入口：写 YAML → loadConfig。 */
export function loadFromRaw(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = TEST_ENV,
): WrittenConfig & { config: AppConfig } {
  const written = writeRawConfig(raw);
  const config = loadConfig({ configPath: written.configPath, env, dataDir: written.dataDir });
  return { ...written, config };
}

/** 走真实配置入口 + 真实前置检查：写 YAML → loadConfig → runPreflight。 */
export function preflightFromRaw(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = TEST_ENV,
): WrittenConfig & { config: AppConfig; report: PreflightReport } {
  const loaded = loadFromRaw(raw, env);
  const report = runPreflight({ config: loaded.config, env });
  return { ...loaded, report };
}

/** 不经文件直接构造 AppConfig（用于只测运行期策略/管线的场景）。 */
export function makeConfig(
  routes: readonly RouteConfig[],
  options: { compliance?: Record<string, unknown>; gateway?: Record<string, unknown>; dataDir?: string } = {},
): AppConfig {
  const raw = rawConfig(routes, { gateway: options.gateway, compliance: options.compliance });
  const parsed = rawConfigSchema.parse(raw);
  return normalizeConfig(parsed, { dataDir: options.dataDir ?? tempDir("data") });
}

export function matrixOf(config: AppConfig): CompiledMatrix {
  return compileMatrix(config.routes);
}

export function violationCodes(report: PreflightReport): string[] {
  return report.violations.map((violation) => violation.code);
}

/** 断言报告里存在指定错误码（精确匹配；错误码是本项目对外承诺的稳定标识）。 */
export function hasViolation(
  report: { violations: ReadonlyArray<{ code: string }> },
  code: string,
): boolean {
  return report.violations.some((violation) => violation.code === code);
}

// ─────────────────────────────────────────────────────────────────────────────
// 消息与网关替身
// ─────────────────────────────────────────────────────────────────────────────

let messageSeq = 0;

export interface IncomingOverrides {
  platform?: Platform;
  conversationId?: string;
  chatType?: ChatType;
  messageId?: string;
  senderId?: string;
  senderIsSelf?: boolean;
  senderIsBot?: boolean;
  kind?: MessageKind;
  text?: string | null;
  receivedAt?: number;
}

export function incoming(overrides: IncomingOverrides = {}): IncomingMessage {
  messageSeq += 1;
  const kind: MessageKind = overrides.kind ?? "text";
  return {
    platform: overrides.platform ?? "wechat",
    conversationId: overrides.conversationId ?? "wxid_self",
    chatType: overrides.chatType ?? "private",
    messageId: overrides.messageId ?? `test-msg-${messageSeq}`,
    senderId: overrides.senderId ?? "user-1",
    senderIsSelf: overrides.senderIsSelf ?? false,
    senderIsBot: overrides.senderIsBot ?? false,
    kind,
    text: overrides.text !== undefined ? overrides.text : kind === "text" ? "test message" : null,
    receivedAt: overrides.receivedAt ?? FIXED_NOW,
  };
}

export interface FakeGatewayOptions {
  /** "increment"（默认）：返回 fake-msg-N；"none"：网关不返回 messageId（覆盖指纹兜底层）。 */
  messageIds?: "increment" | "none";
}

export interface FakeGateway {
  client: GatewayClient;
  sent: GatewaySendRequest[];
}

/** 记录发送请求、按需返回递增 messageId 的假网关（不触碰网络）。 */
export function fakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const sent: GatewaySendRequest[] = [];
  let seq = 0;
  const client: GatewayClient = {
    async send(request: GatewaySendRequest): Promise<SendOutcome> {
      sent.push(request);
      seq += 1;
      return {
        ok: true,
        messageId: options.messageIds === "none" ? null : `fake-msg-${seq}`,
        errorCode: null,
        latencyMs: 0,
      };
    },
  };
  return { client, sent };
}

// ─────────────────────────────────────────────────────────────────────────────
// LoopGuard / Logger / Forwarder
// ─────────────────────────────────────────────────────────────────────────────

export function makeLoopGuard(overrides: Partial<LoopGuardOptions> = {}): LoopGuard {
  return new LoopGuard({
    enabled: true,
    echoTtlMs: 5 * 60 * 1000,
    fingerprintWindowMs: 20 * 1000,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

/** 按配置构造 LoopGuard（与 src/main.ts 的接线方式保持一致，固定时钟保证确定性）。 */
export function loopGuardFromConfig(config: AppConfig): LoopGuard {
  const settings = config.compliance.loopGuard;
  return makeLoopGuard({
    enabled: settings.enabled,
    echoTtlMs: settings.echoTtlMs,
    fingerprintWindowMs: settings.fingerprintWindowMs,
  });
}

export interface MemoryLogger {
  logger: Logger;
  lines: string[];
}

export function memoryLogger(level: LogLevel = "debug"): MemoryLogger {
  const lines: string[] = [];
  const logger = new Logger({ level, sink: (line) => lines.push(line), now: () => new Date(FIXED_NOW) });
  return { logger, lines };
}

export function silentLogger(level: LogLevel = "error"): Logger {
  return new Logger({ level, sink: () => undefined, now: () => new Date(FIXED_NOW) });
}

export interface ForwarderHarnessOptions {
  config: AppConfig;
  matrix?: CompiledMatrix;
  gateway: GatewayClient;
  consent?: ConsentService | null;
  loopGuard?: LoopGuard;
  logger?: Logger;
  crossBorderOpen?: boolean;
}

export function makeForwarder(options: ForwarderHarnessOptions): Forwarder {
  return new Forwarder({
    config: options.config,
    matrix: options.matrix ?? matrixOf(options.config),
    gateway: options.gateway,
    consent: options.consent ?? null,
    loopGuard: options.loopGuard ?? makeLoopGuard(),
    logger: options.logger ?? silentLogger(),
    crossBorderOpen: options.crossBorderOpen ?? false,
  });
}

export function policyContext(
  config: AppConfig,
  options: {
    consent?: PolicyContext["consent"];
    loopGuard?: LoopGuard;
    crossBorderOpen?: boolean;
  } = {},
): PolicyContext {
  return {
    config,
    consent: options.consent ?? null,
    loopGuard: options.loopGuard ?? makeLoopGuard(),
    crossBorderOpen: options.crossBorderOpen ?? false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 异步等待
// ─────────────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询直到条件成立；超时抛出带标签的错误（用于 e2e 的确定性等待）。 */
export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  if (predicate()) {
    return;
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${options.label ?? "条件始终未满足"}`);
}
