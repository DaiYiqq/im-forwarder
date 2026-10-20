/**
 * 结构化日志。
 *
 * 需求第 8 条：日志只记录「时间戳 + 来源平台 + 目标平台 + 成功/失败状态」，不记录消息内容。
 *
 * 这里用两道防线保证这一点：
 *  1. **类型层**：LogFields 的键被限制在白名单类型里，想传一个 content 字段编译期就报错；
 *  2. **运行层**：写入前按白名单逐字段 pick，多余字段直接丢弃；字符串值再做过长截断
 *     与控制字符清理，避免有人把正文塞进 errorCode 之类的"合法字段"里带出去。
 *
 * 因此即使某天有人写错，正文也不会出现在日志里 —— 这是可测试的性质（见 test/redaction.spec.ts）。
 */

import type { MessageKind, Platform } from "../types";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 日志允许出现的字段（除此之外一律丢弃）。 */
export const LOG_FIELD_WHITELIST = [
  "event",
  "routeId",
  "sourcePlatform",
  "targetPlatform",
  "status",
  "kind",
  "scope",
  "errorCode",
  "latencyMs",
  "count",
  "attempt",
  "host",
] as const;

export type LogFieldName = (typeof LOG_FIELD_WHITELIST)[number];

export interface LogFields {
  event: string;
  routeId?: string;
  sourcePlatform?: Platform;
  targetPlatform?: Platform;
  status?: string;
  kind?: MessageKind;
  scope?: string;
  errorCode?: string;
  latencyMs?: number;
  count?: number;
  attempt?: number;
  host?: string;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 单个字段值的最大长度；超过则替换为占位符（防止正文通过"合法字段"泄漏）。 */
const MAX_STRING_VALUE_LENGTH = 120;

export interface LoggerOptions {
  level: LogLevel;
  sink?: (line: string) => void;
  now?: () => Date;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly sink: (line: string) => void;
  private readonly now: () => Date;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
  }

  debug(fields: LogFields): void {
    this.write("debug", fields);
  }

  info(fields: LogFields): void {
    this.write("info", fields);
  }

  warn(fields: LogFields): void {
    this.write("warn", fields);
  }

  error(fields: LogFields): void {
    this.write("error", fields);
  }

  enabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  private write(level: LogLevel, fields: LogFields): void {
    if (!this.enabled(level)) return;

    const record: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
    };
    for (const key of LOG_FIELD_WHITELIST) {
      const raw = (fields as unknown as Record<string, unknown>)[key];
      const sanitized = sanitizeLogValue(raw);
      if (sanitized !== undefined) {
        record[key] = sanitized;
      }
    }
    this.sink(JSON.stringify(record));
  }
}

/**
 * 值清洗：
 *  · 字符串：去控制字符/换行，超长则替换为占位符（绝不截断后保留前 N 个字符——那仍可能泄漏正文片段）；
 *  · 数字/布尔：原样；
 *  · 其它类型（对象、数组、undefined）：丢弃。
 */
export function sanitizeLogValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
    if (cleaned.length === 0) return undefined;
    if (cleaned.length > MAX_STRING_VALUE_LENGTH) {
      return `[omitted:${cleaned.length}]`;
    }
    return cleaned;
  }
  return undefined;
}
