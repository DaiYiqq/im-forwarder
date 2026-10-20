/**
 * 转发编排器。
 *
 * 职责边界：
 *  · 决定"这条消息该不该走、走到哪、要不要先告知" —— 但判断逻辑在 routing/policy.ts；
 *  · 这里只负责执行：发送、回执、登记回环防护、写白名单日志。
 *
 * 数据生命周期：消息正文只在本方法调用栈里存在（message.text → rendered.text → 请求体），
 * 不进任何队列、不落盘、不入日志。方法返回后，理论上只留下无法还原的 HMAC 指纹。
 *
 * 同意指令（同意转发/同意出境/撤回同意）会在正常转发判定**之前**被拦截，
 * 且指令消息本身不会被转发 —— 避免把"同意"这个动作当作内容发给对方。
 */

import type { AppConfig } from "../config/schema";
import { RISK_NOTICE_VERSION } from "../config/schema";
import type { ConsentCommand, ConsentScope, ConsentService } from "../compliance/consent";
import type { GatewayClient } from "../gateway/contract";
import type { ForwardStatus, IncomingMessage } from "../types";
import type { Logger } from "../observability/logger";
import type { CompiledMatrix, CompiledRoute } from "../routing/matrix";
import { decideAll, type PolicyDecision } from "../routing/policy";
import { resolveRoutes } from "../routing/resolve";
import type { LoopGuard } from "./loop-guard";
import {
  consentAlreadyGrantedNotice,
  consentRecordedNotice,
  consentRevokedNotice,
  crossBorderConsentNotice,
  crossBorderGrantNeedsDomesticNotice,
  crossBorderNotNeededNotice,
  domesticConsentNotice,
  unsupportedKindNotice,
} from "./notify";
import { renderForTarget } from "./transform";

export interface ForwarderOptions {
  config: AppConfig;
  matrix: CompiledMatrix;
  gateway: GatewayClient;
  consent: ConsentService | null;
  loopGuard: LoopGuard;
  logger: Logger;
  crossBorderOpen: boolean;
}

export class Forwarder {
  private readonly options: ForwarderOptions;
  /** 告知回执冷却：key = 会话 + 路由 + 缺失范围，value = 上次发送时间。 */
  private readonly noticeCooldown = new Map<string, number>();

  constructor(options: ForwarderOptions) {
    this.options = options;
  }

  private get logger(): Logger {
    return this.options.logger;
  }

  async handle(message: IncomingMessage): Promise<ForwardStatus[]> {
    const routes = resolveRoutes(this.options.matrix, message);

    // ── 同意指令优先拦截（只对他人内容路由生效）─────────────────────────
    //
    // 关键安全前提：**只有可能成为"数据主体"的发送方才可以触发同意流程**。
    // 本服务自身账号发出的消息（senderIsSelf）、其它机器人（senderIsBot）、
    // 以及任何群聊消息都不具备这个资格 —— 否则本服务（或任意一个 bot）
    // 只要在自己的会话里发一句「同意转发」，就能替他人写入同意记录，
    // 从而绕过"未同意不转发"这条底线。
    // 资格不符时不走同意分支，交给下面的 decideAll() 按 skipped_self /
    // skipped_bot / skipped_group_forbidden 处理。
    const senderEligibleForConsent =
      !message.senderIsSelf && !message.senderIsBot && message.chatType === "private";

    const consentRoute = routes.find((route) => route.contentOwner === "third-party");
    if (consentRoute && this.options.consent && senderEligibleForConsent) {
      const command = this.options.consent.classifyCommand(message.text);
      if (command) {
        return [await this.handleConsentCommand(message, consentRoute, command)];
      }
    }

    const decisions = decideAll(message, this.options.matrix, {
      config: this.options.config,
      loopGuard: this.options.loopGuard,
      consent: this.options.consent,
      crossBorderOpen: this.options.crossBorderOpen,
    });

    const statuses: ForwardStatus[] = [];
    for (const decision of decisions) {
      if (decision.action === "drop") {
        this.logDrop(message, decision);
        statuses.push(decision.status);
        continue;
      }
      if (decision.action === "notice") {
        statuses.push(await this.handleNotice(message, decision));
        continue;
      }
      for (const target of decision.route.to) {
        statuses.push(await this.sendToTarget(message, decision.route, target, decision.hop));
      }
    }

    return statuses.length > 0 ? statuses : ["skipped_no_route"];
  }

  // ────────────────────────────────────────────────────────────────────────
  // 同意指令
  // ────────────────────────────────────────────────────────────────────────

  private async handleConsentCommand(
    message: IncomingMessage,
    route: CompiledRoute,
    command: ConsentCommand,
  ): Promise<ForwardStatus> {
    const consent = this.options.consent;
    if (!consent) return "blocked_consent_pending";

    const settings = this.options.config.compliance.thirdPartyConsent;
    const scopeKey = consent.scopeKey(message);

    if (command === "revoke") {
      const removed = consent.revoke(message);
      await this.sendNotice(message, consentRevokedNotice(removed), `revoke:${message.messageId}`);
      this.logger.info({
        event: "consent",
        status: "consent_revoked",
        routeId: route.id,
        sourcePlatform: message.platform,
        scope: "all",
        count: consent.recordCount(),
      });
      return "consent_revoked";
    }

    if (command === "grant-domestic") {
      if (consent.hasGrant(message, "domestic", route.id)) {
        await this.sendNotice(message, consentAlreadyGrantedNotice(), `already:${message.messageId}`);
        return "consent_recorded";
      }
      consent.grant(message, "domestic", route.id);
      const needsCrossBorder =
        route.crossBorder &&
        settings.allowCrossBorder &&
        consent.requiredScopes(route).includes("cross-border");
      await this.sendNotice(
        message,
        consentRecordedNotice("domestic", needsCrossBorder),
        `grant-domestic:${message.messageId}`,
      );
      this.logger.info({
        event: "consent",
        status: "consent_recorded",
        routeId: route.id,
        sourcePlatform: message.platform,
        scope: "domestic",
        count: consent.recordCount(),
      });
      return "consent_recorded";
    }

    // grant-cross-border
    if (!route.crossBorder || !settings.allowCrossBorder) {
      await this.sendNotice(message, crossBorderNotNeededNotice(), `no-cross-border:${message.messageId}`);
      return "notice_sent";
    }
    if (!consent.hasGrant(message, "domestic", route.id)) {
      await this.sendNotice(
        message,
        crossBorderGrantNeedsDomesticNotice(settings.consentKeywords[0] ?? "同意转发"),
        `need-domestic-first:${message.messageId}`,
      );
      this.logger.info({
        event: "consent",
        status: "blocked_consent_pending",
        routeId: route.id,
        sourcePlatform: message.platform,
        scope: "domestic",
      });
      return "blocked_consent_pending";
    }
    consent.grant(message, "cross-border", route.id);
    await this.sendNotice(
      message,
      consentRecordedNotice("cross-border", false),
      `grant-cross-border:${message.messageId}`,
    );
    this.logger.info({
      event: "consent",
      status: "consent_recorded",
      routeId: route.id,
      sourcePlatform: message.platform,
      scope: "cross-border",
      count: consent.recordCount(),
    });
    return "consent_recorded";
  }

  // ────────────────────────────────────────────────────────────────────────
  // 回执
  // ────────────────────────────────────────────────────────────────────────

  private async handleNotice(message: IncomingMessage, decision: PolicyDecision): Promise<ForwardStatus> {
    if (decision.action !== "notice") return "skipped_no_route";

    if (decision.reason === "unsupported-kind") {
      if (this.options.config.compliance.unsupportedMedia.replyNotice) {
        await this.sendNotice(
          message,
          unsupportedKindNotice(message.kind),
          `unsupported:${decision.route.id}:${message.messageId}`,
        );
      }
      this.logger.info({
        event: "forward",
        status: "skipped_unsupported_kind",
        routeId: decision.route.id,
        sourcePlatform: message.platform,
        targetPlatform: decision.route.to[0]?.platform,
        kind: message.kind,
      });
      return "skipped_unsupported_kind";
    }

    // 同意未完成：按缺失范围发送告知（有冷却，避免刷屏）
    const consent = this.options.consent;
    if (!consent) return "blocked_consent_pending";

    const settings = this.options.config.compliance.thirdPartyConsent;
    const now = Date.now();
    const cooldownKey = `${consent.scopeKey(message)}|${decision.route.id}|${decision.missing.join("+")}`;
    const lastSent = this.noticeCooldown.get(cooldownKey) ?? 0;

    if (now - lastSent >= settings.noticeCooldownMs) {
      this.noticeCooldown.set(cooldownKey, now);
      if (decision.missing.includes("domestic")) {
        await this.sendNotice(
          message,
          domesticConsentNotice({
            route: decision.route,
            noticeVersion: settings.noticeVersion,
            keyword: settings.consentKeywords[0] ?? "同意转发",
            revokeKeywords: settings.revokeKeywords,
          }),
          `notice-domestic:${decision.route.id}:${message.messageId}`,
        );
      } else if (decision.missing.includes("cross-border")) {
        await this.sendNotice(
          message,
          crossBorderConsentNotice({
            route: decision.route,
            noticeVersion: RISK_NOTICE_VERSION,
            keyword: settings.crossBorderKeywords[0] ?? "同意出境",
            revokeKeywords: settings.revokeKeywords,
          }),
          `notice-cross-border:${decision.route.id}:${message.messageId}`,
        );
      }
    }

    this.logger.info({
      event: "consent",
      status: "blocked_consent_pending",
      routeId: decision.route.id,
      sourcePlatform: message.platform,
      scope: decision.missing.join("+"),
    });
    return "blocked_consent_pending";
  }

  private async sendNotice(message: IncomingMessage, text: string, keySuffix: string): Promise<void> {
    const outcome = await this.options.gateway.send({
      platform: message.platform,
      conversationId: message.conversationId,
      segments: [{ type: "text", text }],
      idempotencyKey: `notice:${keySuffix}`,
    });
    if (!outcome.ok) {
      this.logger.warn({
        event: "notice",
        status: "send_failed",
        sourcePlatform: message.platform,
        errorCode: outcome.errorCode ?? "gateway_error",
        latencyMs: outcome.latencyMs,
      });
      return;
    }
    this.logger.info({
      event: "notice",
      status: "notice_sent",
      sourcePlatform: message.platform,
      latencyMs: outcome.latencyMs,
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // 实际转发
  // ────────────────────────────────────────────────────────────────────────

  private async sendToTarget(
    message: IncomingMessage,
    route: CompiledRoute,
    target: CompiledRoute["to"][number],
    hop: number,
  ): Promise<ForwardStatus> {
    if (message.kind !== "text" || message.text === null) {
      // 理论不可达（policy 已拦），保留兜底以防策略被改坏
      return "skipped_unsupported_kind";
    }

    const rendered = renderForTarget({ text: message.text, target: { platform: target.platform } });
    if (rendered.text.length === 0) {
      // 纯空白内容：转发无意义，按"跳过"处理并留痕，避免产生空消息
      this.logger.info({
        event: "forward",
        status: "skipped_unsupported_kind",
        routeId: route.id,
        sourcePlatform: message.platform,
        targetPlatform: target.platform,
      });
      return "skipped_unsupported_kind";
    }

    const idempotencyKey = `${route.id}:${message.messageId}:${target.platform}:${target.conversationId}`;
    const outcome = await this.options.gateway.send({
      platform: target.platform,
      conversationId: target.conversationId,
      segments: [{ type: "text", text: rendered.text }],
      idempotencyKey,
    });

    if (!outcome.ok) {
      this.logger.error({
        event: "forward",
        status: "send_failed",
        routeId: route.id,
        sourcePlatform: message.platform,
        targetPlatform: target.platform,
        errorCode: outcome.errorCode ?? "gateway_error",
        latencyMs: outcome.latencyMs,
      });
      return "send_failed";
    }

    // 回环防护登记：目标侧这条 messageId 是本服务产生的
    if (outcome.messageId) {
      this.options.loopGuard.rememberEcho(
        target.platform,
        target.conversationId,
        outcome.messageId,
        route.group,
        hop + 1,
      );
    }
    this.options.loopGuard.rememberFingerprint(route.group, rendered.text);

    this.logger.info({
      event: "forward",
      status: "forwarded",
      routeId: route.id,
      sourcePlatform: message.platform,
      targetPlatform: target.platform,
      latencyMs: outcome.latencyMs,
    });
    return "forwarded";
  }

  private logDrop(message: IncomingMessage, decision: PolicyDecision): void {
    if (decision.action !== "drop") return;
    const fields = {
      event: "forward",
      status: decision.status,
      sourcePlatform: message.platform,
      ...(decision.routeId ? { routeId: decision.routeId } : {}),
    } as const;
    if (decision.status === "skipped_no_route" || decision.status === "skipped_self") {
      this.logger.debug(fields);
    } else {
      this.logger.info(fields);
    }
  }
}
