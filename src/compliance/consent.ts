/**
 * 告知—同意服务（《个人信息保护法》第二十三条）。
 *
 * 适用范围：路由声明 contentOwner = "third-party"（转发他人聊天内容）。
 *
 * 实现的是一个真实的"告知 → 单独同意 → 记录 → 可撤回"流程，
 * 而不是一个"我已确认"的自我声明开关。流程细节见 docs/CONSENT-FLOW.md。
 *
 * 必须诚实指出的残留局限（也写在 COMPLIANCE.md 中）：
 *   · 无法验证回复者就是数据主体本人（只能证明"该会话回复方声称同意"）；
 *   · 无法覆盖群聊中的其他成员 —— 所以本项目根本不支持群聊；
 *   · 同意只能约束"后续不转发"，已经转发出去的消息无法追回。
 */

import type { ThirdPartyConsentSettings } from "../config/schema";
import type { RouteConfig } from "../config/schema";
import { RISK_NOTICE_VERSION } from "../config/schema";
import { isCrossBorderEdge } from "./gates";
import type { ConsentRecord, ConsentScope, ConsentStore } from "./consent-store";
import type { IncomingMessage } from "../types";

export type { ConsentScope } from "./consent-store";

export interface ConsentCheck {
  allowed: boolean;
  missing: ConsentScope[];
}

export type ConsentCommand = "grant-domestic" | "grant-cross-border" | "revoke";

const DAY_MS = 24 * 60 * 60 * 1000;

export class ConsentService {
  private readonly store: ConsentStore;
  private readonly settings: ThirdPartyConsentSettings;
  private readonly now: () => number;

  constructor(store: ConsentStore, settings: ThirdPartyConsentSettings, now: () => number = () => Date.now()) {
    this.store = store;
    this.settings = settings;
    this.now = now;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  scopeKey(message: Pick<IncomingMessage, "platform" | "conversationId">): string {
    return `${message.platform}:${message.conversationId}`;
  }

  /** 该路由需要哪些同意范围。出境边需要"境内转发"和"出境"两次独立同意。 */
  requiredScopes(route: RouteConfig): ConsentScope[] {
    if (route.contentOwner !== "third-party") return [];
    const scopes: ConsentScope[] = ["domestic"];
    if (isCrossBorderEdge(route) && this.settings.allowCrossBorder) {
      scopes.push("cross-border");
    }
    return scopes;
  }

  private expectedNoticeVersion(scope: ConsentScope): string {
    return scope === "domestic" ? this.settings.noticeVersion : RISK_NOTICE_VERSION;
  }

  /**
   * 是否已有有效同意。
   *
   * @param routeId 传入时按"链路粒度"校验：该同意必须覆盖这条路由。
   *                不传时退化为"会话粒度"判断（供日志/诊断与旧记录使用）。
   */
  hasGrant(
    message: Pick<IncomingMessage, "platform" | "conversationId">,
    scope: ConsentScope,
    routeId?: string,
  ): boolean {
    const key = this.scopeKey(message);
    const record = this.store.get(key);
    const grant = record?.grants[scope];
    if (!grant) return false;
    if (grant.noticeVersion !== this.expectedNoticeVersion(scope)) return false;
    const expiresAt = Date.parse(grant.expiresAt);
    if (Number.isNaN(expiresAt) || expiresAt <= this.now()) return false;

    if (routeId !== undefined) {
      // 旧版记录没有 routes 字段：语义为"该会话的全部他人内容路由已同意"（向后兼容）。
      if (Array.isArray(grant.routes) && grant.routes.length > 0 && !grant.routes.includes(routeId)) {
        return false;
      }
    }
    return true;
  }

  check(message: IncomingMessage, route: RouteConfig): ConsentCheck {
    const required = this.requiredScopes(route);
    const missing = required.filter((scope) => !this.hasGrant(message, scope, route.id));
    return { allowed: missing.length === 0, missing };
  }

  /**
   * 记录一次同意。
   *
   * @param routeId 该同意覆盖的路由（链路）。同意按链路累计：
   *                同一会话不同链路需要各自确认，避免"一次同意授权所有接收方"。
   */
  grant(
    message: Pick<IncomingMessage, "platform" | "conversationId">,
    scope: ConsentScope,
    routeId?: string,
  ): void {
    const key = this.scopeKey(message);
    const now = this.now();
    const existing = this.store.get(key);
    const record: ConsentRecord = existing ?? {
      scopeKey: key,
      platform: message.platform,
      conversationId: message.conversationId,
      grants: {},
      updatedAt: new Date(now).toISOString(),
    };

    const previous = record.grants[scope];
    const coveredRoutes = new Set<string>();
    if (previous && Array.isArray(previous.routes)) {
      for (const covered of previous.routes) coveredRoutes.add(covered);
    }
    if (routeId !== undefined) coveredRoutes.add(routeId);

    record.grants[scope] = {
      noticeVersion: this.expectedNoticeVersion(scope),
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.settings.ttlDays * DAY_MS).toISOString(),
      ...(coveredRoutes.size > 0 ? { routes: [...coveredRoutes] } : {}),
    };
    record.updatedAt = new Date(now).toISOString();
    this.store.upsert(record);
  }

  /** 撤回全部同意范围；返回是否确实有记录被删除。 */
  revoke(message: Pick<IncomingMessage, "platform" | "conversationId">): boolean {
    return this.store.remove(this.scopeKey(message));
  }

  /**
   * 识别同意指令。必须是"整条消息精确匹配"，
   * 避免对方在正常聊天里引用到这些词就误触发授权。
   */
  classifyCommand(text: string | null): ConsentCommand | null {
    if (text === null) return null;
    const normalized = normalizeCommandText(text);
    if (normalized.length === 0) return null;
    if (this.settings.revokeKeywords.some((keyword) => normalizeCommandText(keyword) === normalized)) {
      return "revoke";
    }
    if (this.settings.consentKeywords.some((keyword) => normalizeCommandText(keyword) === normalized)) {
      return "grant-domestic";
    }
    if (this.settings.crossBorderKeywords.some((keyword) => normalizeCommandText(keyword) === normalized)) {
      return "grant-cross-border";
    }
    return null;
  }

  recordCount(): number {
    return this.store.size();
  }
}

/** 去空白、去常见中英文标点，做小写化，仅用于命令比对（不用于内容分析）。 */
export function normalizeCommandText(text: string): string {
  return text
    .trim()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[。，、！？!?.,;；:："'“”'']/gu, "")
    .toLowerCase();
}
