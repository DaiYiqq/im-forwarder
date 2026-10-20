/**
 * 配置 schema 与归一化。
 *
 * 设计要点：
 *  1. 全部对象 `.strict()`：出现未知字段直接失败。这样可以挡住"顺手加个 wechat.cookie"
 *     之类的越界配置，而不是静默忽略。
 *  2. 所有合规开关的默认值都是"关闭/最保守"。默认配置不提供任何例外。
 *  3. `contentOwner` 没有默认值，必须由使用者显式声明 —— 因为"是否转发他人聊天内容"
 *     是整个项目里唯一不能由程序自行判断的事实。
 */

import { z } from "zod";
import { DEFAULT_FIELD_MAP, type GatewayFieldMap } from "../gateway/contract";
import type { ChatType, EndpointRef, Platform } from "../types";

export const platformSchema = z.enum(["wechat", "qq", "telegram"]);
export const chatTypeSchema = z.enum(["private", "group"]);

export const endpointSchema = z
  .object({
    platform: platformSchema,
    conversationId: z.string().min(1).max(128),
    chatType: chatTypeSchema,
  })
  .strict();

/**
 * PIPL 第二十三条要求的"告知"要素。
 * 当路由声明 contentOwner=third-party 时，每个目标都必须提供这些字段，
 * 否则前置检查拒绝启动 —— 让"忘记告知"在结构上不可能发生。
 */
export const receiverNoticeSchema = z
  .object({
    /** 接收方名称 */
    name: z.string().min(1).max(128),
    /** 接收方联系方式 */
    contact: z.string().min(1).max(256),
    /** 处理目的 */
    purpose: z.string().min(1).max(512),
    /** 处理方式 */
    method: z.string().min(1).max(512),
    /** 信息种类 */
    dataCategories: z.array(z.string().min(1).max(64)).min(1),
    /** 保存期限 */
    retention: z.string().min(1).max(256),
  })
  .strict();

export const routeTargetSchema = endpointSchema.extend({
  receiver: receiverNoticeSchema.optional(),
});

export const routeSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** 同一逻辑链路的分组名；回环防护按 group 判定 */
    group: z.string().min(1).max(64),
    contentOwner: z.enum(["self", "third-party"]),
    from: endpointSchema,
    to: z.array(routeTargetSchema).min(1).max(8),
  })
  .strict();

export const rawConfigSchema = z
  .object({
    version: z.literal(1),
    gateway: z
      .object({
        baseUrl: z.string().url().max(512),
        eventsUrl: z.string().url().max(512),
        /** 环境变量名，而不是密钥本身 */
        tokenEnv: z.string().min(1).max(128),
        send: z
          .object({ path: z.string().min(1).max(256) })
          .strict()
          .optional(),
        requestTimeoutMs: z.number().int().min(1000).max(120000).optional(),
        maxRetries: z.number().int().min(0).max(5).optional(),
        /** 只允许覆盖 DEFAULT_FIELD_MAP 中已存在的键 */
        fieldMap: z.record(z.string().min(1).max(256)).optional(),
      })
      .strict(),
    compliance: z
      .object({
        telegramCrossBorder: z
          .object({
            enabled: z.boolean().optional(),
            operator: z.string().max(128).nullable().optional(),
            acknowledgedAt: z.string().max(64).nullable().optional(),
            selfMessagesOnlyConfirmed: z.boolean().optional(),
            riskNoticeVersion: z.string().max(64).optional(),
          })
          .strict()
          .optional(),
        thirdPartyConsent: z
          .object({
            enabled: z.boolean().optional(),
            noticeVersion: z.string().max(64).optional(),
            persist: z.boolean().optional(),
            allowCrossBorder: z.boolean().optional(),
            consentKeywords: z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
            crossBorderKeywords: z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
            revokeKeywords: z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
            noticeCooldownMs: z.number().int().min(0).max(86_400_000).optional(),
            ttlDays: z.number().int().min(1).max(3650).optional(),
          })
          .strict()
          .optional(),
        unsupportedMedia: z.object({ replyNotice: z.boolean().optional() }).strict().optional(),
        loopGuard: z
          .object({
            enabled: z.boolean().optional(),
            echoTtlMs: z.number().int().min(1000).max(86_400_000).optional(),
            fingerprintWindowMs: z.number().int().min(0).max(600_000).optional(),
            maxHops: z.number().int().min(1).max(2).optional(),
          })
          .strict()
          .optional(),
        logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
      })
      .strict()
      .optional(),
    routes: z.array(routeSchema).min(1).max(64),
    dataDir: z.string().min(1).max(512).optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof rawConfigSchema>;

export interface GatewaySettings {
  baseUrl: string;
  eventsUrl: string;
  tokenEnv: string;
  sendPath: string;
  requestTimeoutMs: number;
  maxRetries: number;
  fieldMap: GatewayFieldMap;
}

export interface TelegramCrossBorderSettings {
  enabled: boolean;
  operator: string | null;
  acknowledgedAt: string | null;
  selfMessagesOnlyConfirmed: boolean;
  riskNoticeVersion: string;
}

export interface ThirdPartyConsentSettings {
  enabled: boolean;
  noticeVersion: string;
  persist: boolean;
  allowCrossBorder: boolean;
  consentKeywords: string[];
  crossBorderKeywords: string[];
  revokeKeywords: string[];
  noticeCooldownMs: number;
  ttlDays: number;
}

export interface ComplianceSettings {
  telegramCrossBorder: TelegramCrossBorderSettings;
  thirdPartyConsent: ThirdPartyConsentSettings;
  unsupportedMedia: { replyNotice: boolean };
  loopGuard: { enabled: boolean; echoTtlMs: number; fingerprintWindowMs: number; maxHops: number };
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface ReceiverNotice {
  name: string;
  contact: string;
  purpose: string;
  method: string;
  dataCategories: string[];
  retention: string;
}

export interface RouteTarget extends EndpointRef {
  platform: Platform;
  chatType: ChatType;
  receiver?: ReceiverNotice;
}

export interface RouteConfig {
  id: string;
  group: string;
  contentOwner: "self" | "third-party";
  from: EndpointRef;
  to: RouteTarget[];
}

export interface AppConfig {
  version: 1;
  gateway: GatewaySettings;
  compliance: ComplianceSettings;
  routes: RouteConfig[];
  /** 绝对路径；同意元数据目录（不含任何聊天正文） */
  dataDir: string;
}

/** 当前风险告知文案版本；改文案必须同步升版本号，已存的同意记录随之失效。 */
export const RISK_NOTICE_VERSION = "2026-10-18.v1";
export const CONSENT_NOTICE_VERSION = "2026-10-18.v1";

/** 默认合规基线：全部关闭。 */
export function defaultComplianceSettings(): ComplianceSettings {
  return {
    telegramCrossBorder: {
      enabled: false,
      operator: null,
      acknowledgedAt: null,
      selfMessagesOnlyConfirmed: false,
      riskNoticeVersion: RISK_NOTICE_VERSION,
    },
    thirdPartyConsent: {
      enabled: false,
      noticeVersion: CONSENT_NOTICE_VERSION,
      persist: true,
      allowCrossBorder: false,
      consentKeywords: ["同意转发"],
      crossBorderKeywords: ["同意出境"],
      revokeKeywords: ["撤回同意"],
      noticeCooldownMs: 10 * 60 * 1000,
      ttlDays: 30,
    },
    unsupportedMedia: { replyNotice: true },
    loopGuard: {
      enabled: true,
      echoTtlMs: 5 * 60 * 1000,
      fingerprintWindowMs: 20 * 1000,
      maxHops: 1,
    },
    logLevel: "info",
  };
}

export interface NormalizeOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}

/** 把已通过 schema 校验的原始配置补全为运行时配置（默认值在此集中体现）。 */
export function normalizeConfig(raw: RawConfig, options: NormalizeOptions): AppConfig {
  const defaults = defaultComplianceSettings();
  const c = raw.compliance ?? {};

  const telegram = { ...defaults.telegramCrossBorder, ...(c.telegramCrossBorder ?? {}) };
  const consent = { ...defaults.thirdPartyConsent, ...(c.thirdPartyConsent ?? {}) };
  const loopGuard = { ...defaults.loopGuard, ...(c.loopGuard ?? {}) };
  const unsupported = { ...defaults.unsupportedMedia, ...(c.unsupportedMedia ?? {}) };

  // 下发 fieldMap 只允许覆盖已知键，防止把网关事件结构"半映射"成不可审计状态。
  const fieldMap: GatewayFieldMap = { ...DEFAULT_FIELD_MAP };
  for (const [key, value] of Object.entries(raw.gateway.fieldMap ?? {})) {
    if (!(key in DEFAULT_FIELD_MAP)) {
      throw new Error(`gateway.fieldMap 含未知字段：${key}`);
    }
    (fieldMap as unknown as Record<string, string>)[key] = value;
  }

  const sendPath = raw.gateway.send?.path ?? "/api/v1/messages/send";

  return {
    version: 1,
    gateway: {
      baseUrl: raw.gateway.baseUrl.replace(/\/+$/, ""),
      eventsUrl: raw.gateway.eventsUrl,
      tokenEnv: raw.gateway.tokenEnv,
      sendPath: sendPath.startsWith("/") ? sendPath : `/${sendPath}`,
      requestTimeoutMs: raw.gateway.requestTimeoutMs ?? 10_000,
      maxRetries: raw.gateway.maxRetries ?? 2,
      fieldMap,
    },
    compliance: {
      telegramCrossBorder: telegram,
      thirdPartyConsent: consent,
      unsupportedMedia: unsupported,
      loopGuard,
      logLevel: c.logLevel ?? defaults.logLevel,
    },
    routes: raw.routes.map((route) => ({
      id: route.id,
      group: route.group,
      contentOwner: route.contentOwner,
      from: { ...route.from },
      to: route.to.map((target) => ({
        platform: target.platform,
        conversationId: target.conversationId,
        chatType: target.chatType,
        ...(target.receiver ? { receiver: { ...target.receiver } } : {}),
      })),
    })),
    dataDir: options.dataDir,
  };
}
