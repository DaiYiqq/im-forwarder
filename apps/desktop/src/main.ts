/**
 * Electron 主进程。
 *
 * 职责：单实例锁、托盘常驻、窗口与导航白名单、IPC、内嵌核心进程（utilityProcess）、
 * 伴生 HTTP 服务（127.0.0.1 / 显式局域网模式）、内存日志环形缓冲、配置保存前校验。
 *
 * 安全红线（本文件逐条落实）：
 *   · 渲染进程：contextIsolation:true、nodeIntegration:false、sandbox:true，只经 preload 具名 API；
 *   · 令牌：只经 safeStorage 加密落盘或环境变量；不写 config.yaml、不进日志、不进渲染进程、不进 URL；
 *   · 日志：只保留 9 个白名单字段；环形缓冲最多 1000 条，只在内存；不落盘；
 *   · 配置：保存/启动前都执行核心 loadConfig + runPreflight；有违规只报错，不自动修正、不绕过；
 *   · 伴生 API：默认 127.0.0.1；局域网需显式开关 + 确认 + 配对码；无 token 一律 401；
 *   · 外部导航：只允许 GitHub 仓库链接交给系统浏览器，其余一律拒绝；
 *   · 不引入 autoUpdater / 遥测 / 崩溃上报。
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ConfigError,
  evaluateCrossBorderGate,
  formatPreflightFailure,
  loadConfig,
  runPreflight,
  RISK_NOTICE_VERSION,
  type AppConfig,
} from "./preflight";
import {
  IPC,
  sanitizeLogRecord,
  type AppInfo,
  type CompanionState,
  type ConfigState,
  type ControlResult,
  type ForwardCounts,
  type LogRecord,
  type SaveResult,
  type StatusSnapshot,
  type TokenStatus,
  type ValidationResult,
  type Violation,
} from "./ipc";
import { CompanionServer, type CompanionStateProvider, type RouteSummary } from "./companion/server";
import {
  InMemoryTokenStore,
  PairingManager,
  generateToken,
  TOKEN_TTL_MS,
  type CompanionTokenStore,
} from "./companion/auth";

const APP_NAME = "im-forwarder";
const COMPANION_APP_NAME = "im-forwarder-desktop";
const DEFAULT_COMPANION_PORT = 17871;
const MAX_LOG_BUFFER = 1000;
const TOKEN_FILE = "easybot-token.bin";
const COMPANION_TOKEN_FILE = "companion-token.bin";
const SETTINGS_FILE = "settings.json";
const SMOKE = process.argv.includes("--smoke");
const EXIT_COMPLIANCE = 78;

// ──────────────────────────────────────────────────────────────────────────
// 全局状态
// ──────────────────────────────────────────────────────────────────────────

interface Settings {
  companionPort: number;
  lanMode: boolean;
}

let settings: Settings = { companionPort: DEFAULT_COMPANION_PORT, lanMode: false };
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

let coreProcess: UtilityProcess | null = null;
let coreStatus: StatusSnapshot = emptyStatus();
let pendingStart: {
  resolve: (result: ControlResult) => void;
  timer: NodeJS.Timeout;
} | null = null;

let currentConfig: AppConfig | null = null;
let configPath = "";
const logBuffer: LogRecord[] = [];

let companionServer: CompanionServer | null = null;
let companionError: string | null = null;
let companionTokens: CompanionTokenStore = new InMemoryTokenStore();
let companionCredentialsPersistent = false;
let pairing = new PairingManager();
let companionStartPromise: Promise<void> | null = null;

function emptyStatus(): StatusSnapshot {
  return {
    running: false,
    startedAt: null,
    routeCount: 0,
    gateway: { baseUrlHost: "" },
    crossBorderOpen: false,
    counts: { forwarded: 0, failed: 0, skipped: 0 },
  };
}

const userData = app.getPath("userData");
const appPath = app.getAppPath();

// ──────────────────────────────────────────────────────────────────────────
// 基础路径与设置
// ──────────────────────────────────────────────────────────────────────────

function configFilePath(): string {
  const override = process.env["IM_CONFIG_PATH"];
  if (override && override.trim().length > 0) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  return join(userData, "config.yaml");
}

/** 打包后的示例配置（extraResources）或开发态仓库路径。 */
function exampleConfigCandidates(): string[] {
  return [
    join(process.resourcesPath, "config", "config.example.yaml"),
    join(appPath, "../../config/config.example.yaml"),
    join(appPath, "../config/config.example.yaml"),
    join(process.cwd(), "config", "config.example.yaml"),
  ];
}

function resolveExampleConfig(): string | null {
  for (const candidate of exampleConfigCandidates()) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  return null;
}

/** 首次启动：userData/config.yaml 不存在时从示例复制。绝不覆盖已有配置。 */
function ensureUserConfig(): void {
  configPath = configFilePath();
  if (existsSync(configPath)) return;
  const example = resolveExampleConfig();
  if (!example) {
    throw new Error("找不到示例配置 config/config.example.yaml（安装包资源缺失）");
  }
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, readFileSync(example, "utf8"), "utf8");
}

function settingsFilePath(): string {
  return join(userData, SETTINGS_FILE);
}

function loadSettings(): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFilePath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const port = record["companionPort"];
      if (typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535) {
        settings.companionPort = port;
      }
      settings.lanMode = record["lanMode"] === true;
    }
  } catch {
    // 设置缺失/损坏时回到默认值（默认只监听 127.0.0.1）。
  }
}

function saveSettings(): void {
  try {
    mkdirSync(userData, { recursive: true });
    const temp = `${settingsFilePath()}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(temp, settingsFilePath());
  } catch {
    // 设置写失败不影响运行（只是下次启动回到默认端口）。
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 令牌：safeStorage 加密 / 环境变量（绝不进入 config、日志、渲染进程、URL）
// ──────────────────────────────────────────────────────────────────────────

function tokenFilePath(): string {
  return join(userData, TOKEN_FILE);
}

function readStoredToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (!existsSync(tokenFilePath())) return null;
    const decrypted = safeStorage.decryptString(readFileSync(tokenFilePath()));
    return decrypted.trim().length > 0 ? decrypted : null;
  } catch {
    return null;
  }
}

interface ResolvedToken {
  value: string | null;
  source: "safeStorage" | "env" | "none";
}

function resolveToken(): ResolvedToken {
  const envName = currentConfig?.gateway.tokenEnv ?? "EASYBOT_TOKEN";
  const envValue = process.env[envName];
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return { value: envValue, source: "env" };
  }
  const stored = readStoredToken();
  if (stored) return { value: stored, source: "safeStorage" };
  return { value: null, source: "none" };
}

function tokenStatusPayload(): TokenStatus {
  const resolved = resolveToken();
  return {
    saved: resolved.source !== "none",
    source: resolved.source,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    tokenEnv: currentConfig?.gateway.tokenEnv ?? "EASYBOT_TOKEN",
  };
}

function saveToken(raw: string): TokenStatus {
  const token = raw.trim();
  if (token.length === 0) throw new Error("令牌不能为空");
  if (token.length > 512) throw new Error("令牌过长（上限 512 字符）");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "当前系统不支持 safeStorage 加密（缺少可用的系统密钥环），拒绝明文保存令牌。" +
        "请改用环境变量传入（例如设置 EASYBOT_TOKEN）。",
    );
  }
  mkdirSync(userData, { recursive: true });
  writeFileSync(tokenFilePath(), safeStorage.encryptString(token), { mode: 0o600 });
  return tokenStatusPayload();
}

function clearToken(): TokenStatus {
  try {
    if (existsSync(tokenFilePath())) rmSync(tokenFilePath(), { force: true });
  } catch {
    // 删除失败不暴雷；下一次读取会走环境变量/未配置分支。
  }
  return tokenStatusPayload();
}

function envWithToken(config: AppConfig | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const resolved = resolveToken();
  if (resolved.value && config) {
    env[config.gateway.tokenEnv] = resolved.value;
  }
  return env;
}

// ──────────────────────────────────────────────────────────────────────────
// 配置读取 / 校验 / 保存
// ──────────────────────────────────────────────────────────────────────────

interface LoadedConfig {
  ok: boolean;
  config: AppConfig | null;
  violations: Violation[];
}

function loadDesktopConfig(path: string, env: NodeJS.ProcessEnv): LoadedConfig {
  try {
    const config = loadConfig({ configPath: path, env, cwd: userData });
    return { ok: true, config, violations: [] };
  } catch (error) {
    if (error instanceof ConfigError) {
      return {
        ok: false,
        config: null,
        violations: [
          {
            code: error.code,
            message: error.message,
            ...(error.details.length > 0 ? { hint: error.details.join("\n") } : {}),
          },
        ],
      };
    }
    return {
      ok: false,
      config: null,
      violations: [{ code: "CONFIG_LOAD_FAILED", message: "配置读取失败（详情见主进程日志）" }],
    };
  }
}

function preflightViolations(config: AppConfig): Violation[] {
  const report = runPreflight({ config, env: envWithToken(config) });
  if (report.ok) return [];
  return report.violations.map((violation) => ({
    code: violation.code,
    message: violation.message,
    ...(violation.hint ? { hint: violation.hint } : {}),
    ...(violation.routeId ? { routeId: violation.routeId } : {}),
  }));
}

/** 保存/启动共用：loadConfig + runPreflight（原样复用核心，不修正、不绕过）。 */
function validateConfigFile(
  path: string,
): { ok: boolean; violations: Violation[]; config: AppConfig | null } {
  const loaded = loadDesktopConfig(path, envWithToken(null));
  if (!loaded.ok || !loaded.config) {
    return { ok: false, violations: loaded.violations, config: null };
  }
  const violations = preflightViolations(loaded.config);
  return { ok: violations.length === 0, violations, config: loaded.config };
}

function validateConfigText(text: string): { ok: boolean; violations: Violation[]; config: AppConfig | null } {
  mkdirSync(userData, { recursive: true });
  const tempPath = join(userData, `config.validate.${randomUUID()}.yaml`);
  try {
    writeFileSync(tempPath, text, "utf8");
    return validateConfigFile(tempPath);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 临时文件清理失败不阻塞流程。
    }
  }
}

function readConfigState(): ConfigState {
  try {
    ensureUserConfig();
  } catch (error) {
    return {
      path: configPath || configFilePath(),
      content: "",
      exists: false,
      exampleAvailable: false,
      error: error instanceof Error ? error.message : "配置初始化失败",
    };
  }
  const content = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  return {
    path: configPath,
    content,
    exists: existsSync(configPath),
    exampleAvailable: resolveExampleConfig() !== null,
  };
}

function saveConfigText(text: string): SaveResult {
  const result = validateConfigText(text);
  if (!result.ok || !result.config) {
    return {
      ok: false,
      saved: false,
      violations: result.violations,
      routeCount: 0,
    };
  }
  ensureUserConfig();
  const temp = `${configPath}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, configPath);
  currentConfig = result.config;
  refreshCompanionState();
  return {
    ok: true,
    saved: true,
    violations: [],
    routeCount: result.config.routes.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 日志环形缓冲（内存，最多 1000 条，只保留 9 个白名单字段）
// ──────────────────────────────────────────────────────────────────────────

function pushLogRecord(raw: unknown): void {
  const record = sanitizeLogRecord(raw);
  if (!record) return;
  logBuffer.push(record);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_BUFFER);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.logNew, record);
  }
}

function syntheticLog(level: LogRecord["level"], event: string, status?: string, errorCode?: string): void {
  pushLogRecord({
    ts: new Date().toISOString(),
    level,
    event,
    ...(status ? { status } : {}),
    ...(errorCode ? { errorCode } : {}),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 状态广播
// ──────────────────────────────────────────────────────────────────────────

function broadcastStatus(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.statusChanged, coreStatus);
  }
  rebuildTrayMenu();
}

function refreshCompanionState(): void {
  const state = companionStatePayload();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.companionChanged, state);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 核心进程（utilityProcess）
// ──────────────────────────────────────────────────────────────────────────

function coreRunnerPath(): string {
  return join(appPath, "dist", "core-runner.cjs");
}

function normalizeStatus(raw: unknown): StatusSnapshot | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const gateway = record["gateway"];
  const counts = record["counts"];
  if (typeof gateway !== "object" || gateway === null) return null;
  if (typeof counts !== "object" || counts === null) return null;
  const countsRecord = counts as Record<string, unknown>;
  const host = (gateway as Record<string, unknown>)["baseUrlHost"];
  const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return {
    running: record["running"] === true,
    startedAt: typeof record["startedAt"] === "number" ? record["startedAt"] : null,
    routeCount: number(record["routeCount"]),
    gateway: { baseUrlHost: typeof host === "string" ? host : "" },
    crossBorderOpen: record["crossBorderOpen"] === true,
    counts: {
      forwarded: number(countsRecord["forwarded"]),
      failed: number(countsRecord["failed"]),
      skipped: number(countsRecord["skipped"]),
    },
  };
}

function settleStart(result: ControlResult): void {
  const pending = pendingStart;
  if (!pending) return;
  pendingStart = null;
  clearTimeout(pending.timer);
  pending.resolve(result);
}

function handleCoreMessage(message: unknown): void {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  const record = message as Record<string, unknown>;
  const type = record["type"];

  if (type === "log") {
    pushLogRecord(record["record"]);
    return;
  }

  if (type === "status") {
    const status = normalizeStatus(record["payload"]);
    if (!status) return;
    coreStatus = status;
    if (status.running) {
      settleStart({ ok: true, running: true });
    }
    broadcastStatus();
    return;
  }

  if (type === "fatal") {
    const code = typeof record["code"] === "string" ? record["code"] : "CORE_FATAL";
    const violations = Array.isArray(record["violations"])
      ? (record["violations"] as unknown[])
          .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
          .slice(0, 64)
          .map((item) => {
            const violation: Violation = {
              code: typeof item["code"] === "string" ? item["code"].slice(0, 64) : "UNKNOWN",
              message: typeof item["message"] === "string" ? item["message"].slice(0, 1024) : "",
            };
            if (typeof item["hint"] === "string") violation.hint = item["hint"].slice(0, 4096);
            if (typeof item["routeId"] === "string") violation.routeId = item["routeId"].slice(0, 64);
            return violation;
          })
      : [];
    coreStatus = { ...emptyStatus(), routeCount: coreStatus.routeCount };
    syntheticLog("error", "core_process", "fatal", code);
    settleStart({ ok: false, running: false, violations });
    broadcastStatus();
  }
}

async function startCore(): Promise<ControlResult> {
  if (coreProcess) {
    return { ok: true, running: coreStatus.running };
  }
  ensureUserConfig();
  const { ok, violations, config } = validateConfigFile(configPath);
  if (!ok || !config) {
    return { ok: false, running: false, violations };
  }
  currentConfig = config;

  const env: NodeJS.ProcessEnv = { ...envWithToken(config) };
  env["IM_CONFIG_PATH"] = configPath;
  env["IM_CWD"] = userData;
  delete env["ELECTRON_RUN_AS_NODE"];

  const runnerPath = coreRunnerPath();
  if (!existsSync(runnerPath)) {
    return {
      ok: false,
      running: false,
      violations: [{ code: "CORE_BUNDLE_MISSING", message: "找不到 dist/core-runner.cjs，请先执行 npm run build" }],
    };
  }

  let child: UtilityProcess;
  try {
    child = utilityProcess.fork(runnerPath, [], {
      env,
      stdio: "pipe",
      serviceName: "im-forwarder-core",
    });
  } catch {
    return {
      ok: false,
      running: false,
      violations: [{ code: "CORE_SPAWN_FAILED", message: "核心进程启动失败（utilityProcess.fork 异常）" }],
    };
  }

  coreProcess = child;
  coreStatus = { ...emptyStatus(), routeCount: config.routes.length };
  broadcastStatus();

  // 子进程 stdout/stderr 直接丢弃：核心日志只走白名单消息通道，
  // 避免任何意外写出的内容（含错误对象）进入桌面端可见区域。
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  child.on("message", (message: unknown) => {
    handleCoreMessage(message);
  });
  child.on("exit", (code: number) => {
    if (coreProcess === child) {
      coreProcess = null;
      coreStatus = { ...emptyStatus(), routeCount: coreStatus.routeCount, counts: { ...coreStatus.counts } };
      coreStatus.running = false;
      coreStatus.startedAt = null;
      settleStart({
        ok: false,
        running: false,
        violations: [
          {
            code: "CORE_EXITED",
            message: `核心进程已退出（exit code ${code}）。请查看日志页签中的 core_process 记录。`,
          },
        ],
      });
      broadcastStatus();
    }
  });

  const result = await new Promise<ControlResult>((resolvePromise) => {
    const timer = setTimeout(() => {
      pendingStart = null;
      try {
        child.kill();
      } catch {
        // 忽略终止失败。
      }
      resolvePromise({
        ok: false,
        running: false,
        violations: [{ code: "CORE_START_TIMEOUT", message: "核心进程 10 秒内未报告运行状态" }],
      });
    }, 10_000);
    pendingStart = { resolve: resolvePromise, timer };
  });

  if (!result.ok) {
    try {
      child.kill();
    } catch {
      // 忽略。
    }
    if (coreProcess === child) coreProcess = null;
    coreStatus = emptyStatus();
    broadcastStatus();
  }
  return result;
}

async function stopCore(): Promise<ControlResult> {
  const child = coreProcess;
  if (!child) {
    coreStatus = emptyStatus();
    broadcastStatus();
    return { ok: true, running: false };
  }
  settleStart({ ok: false, running: false });
  const exited = new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5000);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  try {
    child.postMessage({ type: "stop" });
  } catch {
    // 端口已关闭：直接走 kill 兜底。
  }
  await exited;
  try {
    child.kill();
  } catch {
    // 已退出时忽略。
  }
  if (coreProcess === child) coreProcess = null;
  coreStatus = emptyStatus();
  broadcastStatus();
  return { ok: true, running: false };
}

// ──────────────────────────────────────────────────────────────────────────
// 伴生 API
// ──────────────────────────────────────────────────────────────────────────

class EncryptedCompanionTokenStore implements CompanionTokenStore {
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(filePath: string, now: () => number = () => Date.now()) {
    this.filePath = filePath;
    this.now = now;
  }

  get(): { token: string; expiresAt: number } | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      if (!existsSync(this.filePath)) return null;
      const parsed: unknown = JSON.parse(safeStorage.decryptString(readFileSync(this.filePath)));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      const token = record["token"];
      const expiresAt = record["expiresAt"];
      if (typeof token !== "string" || token.length < 20) return null;
      if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
      if (expiresAt <= this.now()) return null;
      return { token, expiresAt };
    } catch {
      return null;
    }
  }

  issue(): { token: string; expiresAt: number } {
    const token = generateToken();
    const expiresAt = this.now() + TOKEN_TTL_MS;
    try {
      mkdirSync(userData, { recursive: true });
      const encrypted = safeStorage.encryptString(JSON.stringify({ token, expiresAt }));
      writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    } catch {
      // 写盘失败时退化为内存令牌（本次运行仍可用，重启后重新配对）。
    }
    return { token, expiresAt };
  }
}

function initCompanionCredentials(): void {
  if (safeStorage.isEncryptionAvailable()) {
    companionCredentialsPersistent = true;
    companionTokens = new EncryptedCompanionTokenStore(join(userData, COMPANION_TOKEN_FILE));
  } else {
    companionCredentialsPersistent = false;
    companionTokens = new InMemoryTokenStore();
  }
}

function sanitizeRoutes(config: AppConfig | null): RouteSummary[] {
  if (!config) return [];
  return config.routes.map((route) => ({
    id: route.id,
    group: route.group,
    contentOwner: route.contentOwner,
    from: { platform: route.from.platform, chatType: route.from.chatType },
    to: route.to.map((target) => ({ platform: target.platform, chatType: target.chatType })),
  }));
}

const companionProvider: CompanionStateProvider = {
  getStatus: () => coreStatus,
  getRoutes: () => sanitizeRoutes(currentConfig),
  getLogs: (limit: number) => logBuffer.slice(-Math.max(1, Math.min(MAX_LOG_BUFFER, limit))),
  control: async (action: "start" | "stop"): Promise<ControlResult> =>
    action === "start" ? await startCore() : await stopCore(),
};

function companionStaticRoots(): string[] {
  return [
    join(appPath, "dist", "companion-web"),
    join(appPath, "../companion-web/dist"),
    join(process.resourcesPath, "companion-web"),
  ];
}

async function startCompanion(): Promise<void> {
  if (companionStartPromise) return await companionStartPromise;
  companionStartPromise = (async () => {
    try {
      if (companionServer) return;
      companionError = null;
      const host = settings.lanMode ? "0.0.0.0" : "127.0.0.1";
      const server = new CompanionServer({
        host,
        port: settings.companionPort,
        state: companionProvider,
        tokens: companionTokens,
        pairing,
        version: app.getVersion(),
        appName: COMPANION_APP_NAME,
        staticRoots: companionStaticRoots(),
        onEvent: (event) => {
          if (event === "companion_paired") {
            syntheticLog("info", "companion", "paired");
            refreshCompanionState();
          }
        },
      });
      try {
        await server.start();
        companionServer = server;
        // 确保 UI 能展示一个有效配对码（10 分钟、一次性）。
        pairing.issue();
        syntheticLog("info", "companion", "listening");
      } catch {
        companionError = `伴生服务启动失败：端口 ${settings.companionPort} 可能被占用或权限不足`;
        syntheticLog("error", "companion", "start_failed", "PORT_UNAVAILABLE");
      }
    } finally {
      companionStartPromise = null;
      refreshCompanionState();
    }
  })();
  return await companionStartPromise;
}

async function stopCompanion(): Promise<void> {
  const server = companionServer;
  companionServer = null;
  if (server) {
    await server.stop();
  }
  refreshCompanionState();
}

async function restartCompanion(): Promise<void> {
  await stopCompanion();
  await startCompanion();
}

function companionStatePayload(): CompanionState {
  const currentPair = pairing.currentCode();
  const token = companionTokens.get();
  const port = companionServer?.address.port ?? settings.companionPort;
  const running = companionServer?.listening === true;
  return {
    running,
    host: settings.lanMode ? "0.0.0.0" : "127.0.0.1",
    port,
    lanMode: settings.lanMode,
    address: settings.lanMode
      ? `http://<本机局域网 IP>:${port}（局域网模式，仅手机与你自己的网络）`
      : `http://127.0.0.1:${port}`,
    pairCode: currentPair?.code ?? null,
    pairCodeExpiresAt: currentPair?.expiresAt ?? null,
    tokenExpiresAt: token?.expiresAt ?? null,
    staticAvailable: companionServer?.staticAvailable ?? false,
    credentialsPersistent: companionCredentialsPersistent,
    warning: settings.lanMode
      ? "⚠ 局域网模式：伴生 API 会监听 0.0.0.0，同一局域网内的设备都可能尝试连接。" +
        "请仅在可信网络使用，并确保配对码不外泄；无令牌访问一律 401，配置只读。"
      : null,
    error: companionError,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 窗口 / 托盘 / 导航安全
// ──────────────────────────────────────────────────────────────────────────

function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return false;
    return url.pathname === "/DaiYiqq" || url.pathname.startsWith("/DaiYiqq/im-forwarder");
  } catch {
    return false;
  }
}

function openExternalSafely(raw: string): boolean {
  if (!isAllowedExternalUrl(raw)) return false;
  void shell.openExternal(raw);
  return true;
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: "im-forwarder 桌面端",
    backgroundColor: "#0b1220",
    autoHideMenuBar: true,
    icon: join(appPath, "dist", "icon.png"),
    webPreferences: {
      preload: join(appPath, "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? "";
    if (url !== current) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  void mainWindow.loadFile(join(appPath, "renderer", "index.html"));
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function toggleWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function trayIcon(): Electron.NativeImage {
  try {
    const image = nativeImage.createFromPath(join(appPath, "dist", "icon.png"));
    if (!image.isEmpty()) {
      return image.resize({ width: 32, height: 32 });
    }
  } catch {
    // 图标缺失时退化为空图标（托盘菜单仍可用）。
  }
  return nativeImage.createEmpty();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const running = coreStatus.running;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 / 隐藏窗口", click: () => toggleWindow() },
      { type: "separator" },
      {
        label: running ? "停止转发" : "启动转发",
        click: () => {
          void (async () => {
            if (coreStatus.running) {
              await stopCore();
            } else {
              const result = await startCore();
              if (!result.ok) {
                syntheticLog("error", "desktop", "start_failed", result.violations?.[0]?.code ?? "UNKNOWN");
                showWindow();
              }
            }
            rebuildTrayMenu();
          })();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.setToolTip(`im-forwarder 桌面端${running ? "（转发中）" : ""}`);
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon());
  } catch {
    tray = null;
    return;
  }
  tray.on("click", () => toggleWindow());
  rebuildTrayMenu();
}

// ──────────────────────────────────────────────────────────────────────────
// IPC
// ──────────────────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.statusGet, () => coreStatus);

  ipcMain.handle(IPC.configRead, () => readConfigState());

  ipcMain.handle(IPC.configExample, () => {
    const example = resolveExampleConfig();
    if (!example) throw new Error("示例配置不可用（安装包资源缺失）");
    return readFileSync(example, "utf8");
  });

  ipcMain.handle(IPC.configValidate, (_event, yaml: unknown): ValidationResult => {
    if (typeof yaml !== "string") throw new Error("参数非法");
    if (yaml.length > 512 * 1024) throw new Error("配置过大（上限 512KB）");
    const result = validateConfigText(yaml);
    return { ok: result.ok, violations: result.violations };
  });

  ipcMain.handle(IPC.configSave, (_event, yaml: unknown): SaveResult => {
    if (typeof yaml !== "string") throw new Error("参数非法");
    if (yaml.length > 512 * 1024) throw new Error("配置过大（上限 512KB）");
    return saveConfigText(yaml);
  });

  ipcMain.handle(IPC.tokenStatus, () => tokenStatusPayload());
  ipcMain.handle(IPC.tokenSet, (_event, token: unknown) => {
    if (typeof token !== "string") throw new Error("参数非法");
    return saveToken(token);
  });
  ipcMain.handle(IPC.tokenClear, () => clearToken());

  ipcMain.handle(IPC.coreStart, async () => await startCore());
  ipcMain.handle(IPC.coreStop, async () => await stopCore());

  ipcMain.handle(IPC.companionState, () => companionStatePayload());

  ipcMain.handle(
    IPC.companionLanMode,
    async (_event, payload: unknown) => {
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("参数非法");
      }
      const record = payload as Record<string, unknown>;
      const enabled = record["enabled"] === true;
      const acknowledged = record["acknowledged"] === true;
      if (enabled && !acknowledged) {
        throw new Error("开启局域网模式需要先在界面上确认风险警告");
      }
      settings.lanMode = enabled;
      saveSettings();
      await restartCompanion();
      return companionStatePayload();
    },
  );

  ipcMain.handle(IPC.companionPort, async (_event, port: unknown) => {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("端口必须是 1024–65535 之间的整数");
    }
    settings.companionPort = port;
    saveSettings();
    await restartCompanion();
    return companionStatePayload();
  });

  ipcMain.handle(IPC.companionNewPairCode, () => {
    pairing.rotate();
    refreshCompanionState();
    return companionStatePayload();
  });

  ipcMain.handle(IPC.logsList, (_event, limit: unknown) => {
    const requested = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : 100;
    const clamped = Math.max(1, Math.min(MAX_LOG_BUFFER, requested));
    return logBuffer.slice(-clamped);
  });

  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      name: APP_NAME,
      version: app.getVersion(),
      electronVersion: process.versions["electron"] ?? "",
      nodeVersion: process.versions["node"] ?? "",
      chromeVersion: process.versions["chrome"] ?? "",
      platform: `${process.platform}-${process.arch}`,
      configPath,
      homepage: "https://github.com/DaiYiqq/im-forwarder",
      issuesUrl: "https://github.com/DaiYiqq/im-forwarder/issues",
      license: "SEE LICENSE IN LICENSE（仅限技术研究学习，禁止商业用途/收费服务/付费托管）",
      signed: false,
      autoUpdate: false,
    };
  });

  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => {
    if (typeof url !== "string") return false;
    return openExternalSafely(url);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 启动 / smoke
// ──────────────────────────────────────────────────────────────────────────

function printSmokeResult(ok: boolean, lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(ok ? "[smoke] PASS\n" : "[smoke] FAIL\n");
}

/**
 * --smoke：不创建窗口、不建托盘、不启动伴生 HTTP 服务。
 * 退出码：0 = 配置与 preflight 全部通过；78 = 配置/合规违规；1 = 意外异常。
 */
async function runSmoke(): Promise<number> {
  const lines: string[] = [];
  try {
    const path = configFilePath();
    if (!existsSync(path)) {
      // 与 GUI 首次启动一致：从示例复制。若 IM_CONFIG_PATH 指定的文件不存在则视为违规（78）。
      if (process.env["IM_CONFIG_PATH"]) {
        printSmokeResult(false, [`[smoke] 配置文件不存在：${path}`, "[smoke] IM_CONFIG_PATH 指定的文件必须存在"]);
        return EXIT_COMPLIANCE;
      }
      const example = resolveExampleConfig();
      if (!example) {
        printSmokeResult(false, ["[smoke] 找不到示例配置，无法初始化 userData/config.yaml"]);
        return EXIT_COMPLIANCE;
      }
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, readFileSync(example, "utf8"), "utf8");
      lines.push(`[smoke] 已从示例初始化配置：${path}`);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    let config: AppConfig;
    try {
      config = loadConfig({ configPath: path, env, cwd: userData });
    } catch (error) {
      if (error instanceof ConfigError) {
        printSmokeResult(false, [
          `[smoke] 配置错误（${error.code}）：${error.message}`,
          ...error.details.map((detail) => `  - ${detail}`),
        ]);
        return EXIT_COMPLIANCE;
      }
      throw error;
    }

    const token = env[config.gateway.tokenEnv];
    const report = runPreflight({ config, env });
    if (!report.ok) {
      printSmokeResult(false, [
        formatPreflightFailure(report),
        `[smoke] 前置检查未通过：${report.violations.map((item) => item.code).join(", ")}`,
      ]);
      return EXIT_COMPLIANCE;
    }

    const matrix = report.matrix;
    const gate = evaluateCrossBorderGate(config.compliance.telegramCrossBorder, RISK_NOTICE_VERSION);
    lines.push(`[smoke] 配置：${path}`);
    lines.push(`[smoke] 网关：${config.gateway.baseUrl}（host=${new URL(config.gateway.baseUrl).host}）`);
    lines.push(`[smoke] 路由：${matrix?.stats.routes ?? 0} 条 / 边 ${matrix?.stats.edges ?? 0} 条`);
    lines.push(`[smoke] 出境闸门：${gate.open ? "OPEN" : "CLOSED"}`);
    lines.push(`[smoke] 令牌：${token ? `环境变量 ${config.gateway.tokenEnv} 已设置` : "未设置"}`);
    lines.push("[smoke] 未创建窗口/托盘/伴生服务，未连接网关，未发送消息。");
    printSmokeResult(true, lines);
    return 0;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    printSmokeResult(false, [`[smoke] 异常：${name}（未输出任何可能含敏感数据的原始错误对象）`]);
    return 1;
  }
}

async function bootstrap(): Promise<void> {
  loadSettings();
  initCompanionCredentials();
  ensureUserConfig();
  const probe = loadDesktopConfig(configPath, envWithToken(null));
  currentConfig = probe.config;
  pushLogRecord({
    ts: new Date().toISOString(),
    level: "info",
    event: "desktop",
    status: "ready",
  });

  registerIpcHandlers();
  createTray();
  createWindow();
  await startCompanion();
  rebuildTrayMenu();
}

// ──────────────────────────────────────────────────────────────────────────
// 应用生命周期
// ──────────────────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });

  app.on("before-quit", () => {
    quitting = true;
    void stopCompanion();
  });

  app.on("will-quit", () => {
    try {
      coreProcess?.kill();
    } catch {
      // 退出阶段的终止失败忽略。
    }
    coreProcess = null;
  });

  app.on("window-all-closed", () => {
    // 托盘常驻应用：关闭窗口不退出（macOS 同样常驻）。
  });

  app.on("activate", () => {
    showWindow();
  });

  void app.whenReady().then(async () => {
    if (SMOKE) {
      const code = await runSmoke();
      app.exit(code);
      return;
    }
    try {
      await bootstrap();
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      dialog.showErrorBox(
        "im-forwarder 桌面端启动失败",
        `初始化失败：${name}。请检查安装包资源与 userData 目录权限。`,
      );
      app.exit(1);
    }
  });
}
