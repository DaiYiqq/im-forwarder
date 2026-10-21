/**
 * im-forwarder 在线 Demo 的**前端演示用**策略模型。
 *
 * ⚠️ 重要说明：
 *  - 这里是真实策略链（src/routing/policy.ts、src/compliance/gates.ts）的**简化镜像**，
 *    只用于在浏览器里演示"为什么某条消息会被转发/被拦截"；
 *  - 它不连接任何平台、不读取任何真实配置、不发送任何消息；
 *  - 真实判定以仓库源码为准，本文件的差异不构成行为承诺。
 *
 * 同时导出为 CommonJS，便于 `node demo/policy-demo.test.mjs` 做自检。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PolicyDemo = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SUPPORTED_KINDS = ["text"];
  const RISK_NOTICE_VERSION = "2026-10-18.v1";

  /** 出境闸门：五要素齐备才放行（与 src/compliance/gates.ts 的判定顺序一致）。 */
  function evaluateCrossBorderGate(settings) {
    const reasons = [];
    if (!settings.enabled) reasons.push("compliance.telegramCrossBorder.enabled = false（默认关闭）");
    if (!settings.operator || settings.operator.trim() === "") reasons.push("缺少 operator（开通者署名）");
    if (!settings.acknowledgedAt) reasons.push("缺少 acknowledgedAt（确认时间戳）");
    else if (Number.isNaN(Date.parse(settings.acknowledgedAt))) reasons.push("acknowledgedAt 不是合法 ISO 8601 时间");
    if (!settings.selfMessagesOnlyConfirmed) reasons.push("selfMessagesOnlyConfirmed = false（未确认仅转发本人消息）");
    if (settings.riskNoticeVersion !== RISK_NOTICE_VERSION) reasons.push("riskNoticeVersion 与当前告知版本不一致");
    return { open: reasons.length === 0, reasons };
  }

  /** 路由结构硬检查（群聊/自环）。 */
  function checkRouteShape(route) {
    const errors = [];
    if (route.from.chatType === "group") {
      errors.push(
        route.from.platform === "wechat"
          ? "WECHAT_GROUP_SOURCE_FORBIDDEN：微信侧不允许群聊"
          : "GROUP_CHAT_UNSUPPORTED：本项目不支持任何平台的群聊",
      );
    }
    for (const target of route.to) {
      if (target.chatType === "group") {
        errors.push(
          target.platform === "wechat"
            ? "WECHAT_GROUP_TARGET_FORBIDDEN：微信侧不允许群聊目标"
            : "GROUP_CHAT_UNSUPPORTED：群聊目标不受支持",
        );
      }
    }
    if (route.to.some((target) => target.platform === route.from.platform && target.conversationId === route.from.conversationId)) {
      errors.push("ROUTE_SELF_LOOP：源与目标相同（自环）");
    }
    return errors;
  }

  /** QQ 目标必须做的 CQ 码转义（演示注入防护）。 */
  function escapeCqCodes(text) {
    return String(text).replace(/&/g, "&amp;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
  }

  /**
   * 按真实策略链顺序做决策，返回每一步的结果，便于 UI 展示"卡在哪一步"。
   * scenarios 只带最小上下文：msg / route / gate / consent / loopEcho / consentGranted。
   */
  function decide(scenario) {
    const steps = [];
    const msg = scenario.msg;
    const route = scenario.route;
    const gate = scenario.gate || { enabled: false, operator: "", acknowledgedAt: "", selfMessagesOnlyConfirmed: false, riskNoticeVersion: "" };

    function step(id, title, ok, detail) {
      steps.push({ id, title, status: ok === "na" ? "na" : ok ? "pass" : "fail", detail });
      return ok;
    }

    // P0 自身 / 机器人消息
    if (!step("P0", "自消息 / 机器人消息过滤", !(msg.senderIsSelf || msg.senderIsBot), msg.senderIsSelf ? "senderIsSelf=true" : msg.senderIsBot ? "senderIsBot=true" : "正常用户消息")) {
      const status = msg.senderIsSelf ? "skipped_self" : "skipped_bot";
      const title = msg.senderIsSelf ? "丢弃：自身消息" : "丢弃：机器人消息（防止 bot 互踢）";
      return finish(status, title, steps, msg);
    }

    // P1 群聊硬门（所有平台）
    if (!step("P1", "群聊硬门（任何平台都不支持）", msg.chatType === "private", msg.chatType === "group" ? "chatType=group" : "chatType=private")) {
      return finish("skipped_group_forbidden", "丢弃：群聊消息（无配置开关可放开）", steps, msg);
    }

    // P2 路由命中
    const matched = Boolean(route) && route.from.conversationId === msg.conversationId;
    if (!step("P2", "路由矩阵命中", matched, matched ? `命中路由 ${route.id}` : "源会话不在路由表中")) {
      return finish("skipped_no_route", "忽略：没有匹配的路由", steps, msg);
    }

    // P3 回显 / hop
    if (!step("P3", "回显 messageId / hop 预算", !scenario.loopEcho, scenario.loopEcho ? "messageId 命中回显表（hop+1 > maxHops）" : "非回显消息")) {
      return finish("skipped_loop_suspected", "丢弃：检测到回环", steps, msg);
    }

    // P4 消息类型白名单
    const kindOk = SUPPORTED_KINDS.includes(msg.kind);
    if (!step("P4", "消息类型白名单（仅文本）", kindOk, kindOk ? "kind=text" : `kind=${msg.kind}（不支持，显式回执后跳过）`)) {
      return finish("skipped_unsupported_kind", "跳过：不支持的消息类型（已向源会话回执）", steps, msg);
    }

    // P5 出境闸门（目标含 Telegram）
    const crossBorder = route.to.some((target) => target.platform === "telegram");
    if (crossBorder) {
      const gateResult = evaluateCrossBorderGate(gate);
      if (!step("P5", "数据出境闸门（PIPL 第 38/39 条）", gateResult.open, gateResult.open ? "五要素齐备" : gateResult.reasons.join("；"))) {
        return finish("blocked_cross_border", "阻断：出境闸门未打开（启动前置检查会直接 exit 78）", steps, msg);
      }
    } else {
      step("P5", "数据出境闸门（PIPL 第 38/39 条）", "na", "目标均在境内，不涉及出境");
    }

    // P6 短期内容指纹（演示中恒不命中）
    step("P6", "短期内容指纹回环", "na", "演示环境无历史出站指纹");

    // P7 他人内容同意
    if (route.contentOwner === "third-party") {
      if (!step("P7", "他人内容告知—同意（PIPL 第 23 条）", Boolean(scenario.consentGranted), scenario.consentGranted ? "已有该链路的同意记录" : "未取得同意，发送告知后阻断")) {
        return finish("blocked_consent_pending", "阻断：等待对方回复「同意转发」", steps, msg);
      }
    } else {
      step("P7", "他人内容告知—同意（PIPL 第 23 条）", "na", "contentOwner=self，仅本人消息");
    }

    // P8 文本转换 + 发送
    const target = route.to[0];
    const rendered = target.platform === "qq" ? escapeCqCodes(msg.text) : msg.text;
    step("P8", "文本转换（CQ 转义 / 截断）", true, target.platform === "qq" ? "已按目标平台转义 CQ 码" : "纯文本直传");
    return {
      status: "forwarded",
      title: `转发：${msg.platform} → ${target.platform}（模拟发送成功）`,
      steps,
      log: logOf(msg, route, "forwarded", target.platform, 42),
      sentPayload: { platform: target.platform, conversationId: "（演示不展示真实 ID）", segments: [{ type: "text", text: rendered }] },
      notice: null,
    };
  }

  function finish(status, title, steps, msg) {
    const notice =
      status === "skipped_unsupported_kind"
        ? "本条消息的类型暂不支持跨平台转发，已跳过。本工具只转发文本消息。"
        : status === "blocked_consent_pending"
          ? "【转发告知】本条消息默认不会转发；若你同意，请回复「同意转发」。（演示文案，真实文案含接收方名称/联系方式/目的/方式/种类/期限）"
          : null;
    return { status, title, steps, log: logOf(msg, null, status, null, null), notice, sentPayload: null };
  }

  /** 日志只允许白名单字段（与 src/observability/logger.ts 一致）。 */
  function logOf(msg, route, status, targetPlatform, latencyMs) {
    const record = { ts: "2026-10-21T09:00:00.000Z", level: status === "forwarded" ? "info" : "warn", event: "forward", status, sourcePlatform: msg.platform };
    if (route) record.routeId = route.id;
    if (targetPlatform) record.targetPlatform = targetPlatform;
    if (typeof latencyMs === "number") record.latencyMs = latencyMs;
    return record;
  }

  const routes = {
    wxSelfToQq: {
      id: "wx-private-to-qq",
      group: "self-wx-qq",
      contentOwner: "self",
      from: { platform: "wechat", conversationId: "wxid_self", chatType: "private" },
      to: [{ platform: "qq", conversationId: "10001", chatType: "private" }],
    },
    wxGroup: {
      id: "wx-group-route",
      group: "bad",
      contentOwner: "self",
      from: { platform: "wechat", conversationId: "wxid_self", chatType: "group" },
      to: [{ platform: "qq", conversationId: "10001", chatType: "private" }],
    },
    wxToTelegram: {
      id: "wx-private-to-telegram",
      group: "self-wx-tg",
      contentOwner: "self",
      from: { platform: "wechat", conversationId: "wxid_self", chatType: "private" },
      to: [{ platform: "telegram", conversationId: "123456789", chatType: "private" }],
    },
    thirdParty: {
      id: "colleague-wx-to-qq",
      group: "third-party-demo",
      contentOwner: "third-party",
      from: { platform: "wechat", conversationId: "wxid_self", chatType: "private" },
      to: [{ platform: "qq", conversationId: "10002", chatType: "private" }],
    },
  };

  const baseMsg = {
    platform: "wechat",
    conversationId: "wxid_self",
    chatType: "private",
    kind: "text",
    text: "晚上七点老地方见",
    senderIsSelf: false,
    senderIsBot: false,
  };

  const scenarios = [
    { id: "normal", label: "正常：微信私聊 → QQ", desc: "自己与自己账号之间的文本消息", route: routes.wxSelfToQq, msg: baseMsg },
    { id: "group", label: "微信群聊消息", desc: "微信群聊一律拒绝，无配置开关", route: routes.wxGroup, msg: { ...baseMsg, chatType: "group" } },
    { id: "media", label: "图片消息", desc: "只支持文本；媒体显式回执后跳过", route: routes.wxSelfToQq, msg: { ...baseMsg, kind: "image", text: null } },
    { id: "self", label: "自己发的消息回显", desc: "senderIsSelf 的消息丢弃", route: routes.wxSelfToQq, msg: { ...baseMsg, senderIsSelf: true } },
    { id: "bot", label: "其它机器人发的消息", desc: "防止 bot 互踢", route: routes.wxSelfToQq, msg: { ...baseMsg, senderIsBot: true } },
    { id: "noroute", label: "未配置路由的会话", desc: "不在路由表中的会话被忽略", route: routes.wxSelfToQq, msg: { ...baseMsg, conversationId: "wxid_unknown" } },
    { id: "tg", label: "转发到 Telegram（闸门关闭）", desc: "出境默认关闭，启动会 exit 78", route: routes.wxToTelegram, msg: baseMsg, gate: { enabled: false, operator: "", acknowledgedAt: "", selfMessagesOnlyConfirmed: false, riskNoticeVersion: "" } },
    { id: "thirdparty", label: "他人内容未同意", desc: "PIPL 第 23 条：先告知，同意后才转发", route: routes.thirdParty, msg: baseMsg, consentGranted: false },
    { id: "loop", label: "回环回显", desc: "messageId 命中回显表，丢弃", route: routes.wxSelfToQq, msg: baseMsg, loopEcho: true },
    { id: "cqinject", label: "CQ 码注入尝试", desc: "对方发 [CQ:at,qq=all]，必须被转义", route: routes.wxSelfToQq, msg: { ...baseMsg, text: "[CQ:at,qq=all] 大家把红包发一下" } },
  ];

  return { RISK_NOTICE_VERSION, SUPPORTED_KINDS, evaluateCrossBorderGate, checkRouteShape, escapeCqCodes, decide, routes, scenarios };
});
