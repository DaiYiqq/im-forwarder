/**
 * 配置加载：读文件 → 危险键扫描 → schema 校验 → 归一化。
 *
 * 三层防线：
 *  1. 危险键扫描：配置文件里出现任何形式的平台登录凭据都会被拒绝。
 *     凭据只应存在于 EasyBot 网关侧（微信 iLink 由网关完成官方扫码/授权），
 *     本服务只持有网关自身的一个访问令牌，且令牌只从环境变量读取。
 *  2. zod `.strict()`：未知字段 = 配置错误，不做"尽力而为"的解释。
 *  3. 归一化集中补默认值：默认值只有一处来源（defaultComplianceSettings）。
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import {
  normalizeConfig,
  rawConfigSchema,
  type AppConfig,
} from "./schema";

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.details = details;
  }
}

/**
 * 配置文件中绝对不允许出现的键。
 * 说明：这些是"属于平台或属于网关"的东西。本服务一旦持有它们，
 * 就意味着存在绕过网关直连平台的可能，因此从配置入口直接封死。
 */
const FORBIDDEN_KEY_RULES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(^|_)(cookie|cookies|cookie_?jar|session_?key)$/i,
    reason: "本服务不接受任何平台登录态/Cookie（微信登录必须由网关侧官方 iLink 通道完成）",
  },
  {
    pattern: /bot_?token|ilink|qrcode|login_?token|scan_?code/i,
    reason: "微信 iLink(ClawBot) 的 bot_token / ilink_* / 二维码票据属于网关侧，禁止出现在本服务配置",
  },
  {
    pattern: /(^|_)(password|passwd|secret|private_?key)$/i,
    reason: "本服务不需要任何平台口令；密钥请用环境变量并在网关侧配置",
  },
  {
    pattern: /telethon|pyrogram|mtproto|api_?hash|session_?string|userbot/i,
    reason: "禁止任何以个人号身份登录 Telegram 的方案；Telegram 只能走官方 Bot API（由网关完成）",
  },
];

interface ForbiddenHit {
  path: string;
  reason: string;
}

/** 深度遍历已解析的配置，找出危险键（大小写不敏感）。 */
export function findForbiddenConfigKeys(node: unknown, path: string[] = []): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      hits.push(...findForbiddenConfigKeys(item, [...path, String(index)]));
    });
    return hits;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const rule = FORBIDDEN_KEY_RULES.find((candidate) => candidate.pattern.test(key));
      if (rule) {
        hits.push({ path: [...path, key].join("."), reason: rule.reason });
      }
      hits.push(...findForbiddenConfigKeys(value, [...path, key]));
    }
  }
  return hits;
}

export interface LoadConfigOptions {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  /** 覆盖 dataDir；否则用配置里的 dataDir 或 <cwd>/data */
  dataDir?: string;
  cwd?: string;
}

export function loadConfig(options: LoadConfigOptions): AppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = isAbsolute(options.configPath)
    ? options.configPath
    : resolve(cwd, options.configPath);

  if (!existsSync(configPath)) {
    throw new ConfigError(`配置文件不存在：${configPath}`, [
      "请从 config/config.example.yaml 复制一份为 config/config.yaml 后再启动。",
    ]);
  }

  const text = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`配置文件 YAML 解析失败：${configPath}`, [String((error as Error).message)]);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("配置文件顶层必须是对象（mapping）");
  }

  const hits = findForbiddenConfigKeys(parsed);
  if (hits.length > 0) {
    throw new ConfigError("配置文件包含禁止出现的敏感键", hits.map((hit) => `${hit.path}：${hit.reason}`));
  }

  let validated: ReturnType<typeof rawConfigSchema.parse>;
  try {
    validated = rawConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError(
        "配置未通过 schema 校验（未知字段也会在此报错）",
        error.issues.map((issue) => `${issue.path.join(".") || "(root)"}：${issue.message}`),
      );
    }
    throw error;
  }

  const dataDir = isAbsolute(options.dataDir ?? validated.dataDir ?? "")
    ? (options.dataDir ?? validated.dataDir)!
    : resolve(cwd, options.dataDir ?? validated.dataDir ?? "data");

  let config: AppConfig;
  try {
    config = normalizeConfig(validated, { dataDir, env });
  } catch (error) {
    throw new ConfigError("配置归一化失败", [String((error as Error).message)]);
  }

  // 只有"确实要落盘同意记录"时才创建 data/ 目录：
  // 避免仅做配置检查（--self-check）就在仓库里留下空目录。
  if (config.compliance.thirdPartyConsent.persist && config.compliance.thirdPartyConsent.enabled) {
    mkdirSync(resolve(dataDir), { recursive: true });
  }

  return config;
}

/** 供 --self-check 打印的配置摘要（不含任何凭据；token 只显示环境变量名）。 */
export function describeConfig(configPath: string, config: AppConfig): string[] {
  return [
    `config      = ${configPath}`,
    `gateway     = ${config.gateway.baseUrl} (events: ${config.gateway.eventsUrl})`,
    `token env   = ${config.gateway.tokenEnv}${process.env[config.gateway.tokenEnv] ? " [已设置]" : " [未设置]"}`,
    `data dir    = ${config.dataDir}${config.compliance.thirdPartyConsent.persist ? "" : " (consent 不落盘)"}`,
    `routes      = ${config.routes.length} 条`,
    `log level   = ${config.compliance.logLevel}`,
  ];
}
