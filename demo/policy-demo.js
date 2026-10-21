/**
 * im-forwarder 在线 Demo 的**前端演示用**策略模型（中英双语）。
 *
 * ⚠️ 说明：
 *  - 这是真实策略链（src/routing/policy.ts、src/compliance/gates.ts、src/routing/matrix.ts）
 *    的**简化镜像**，只用于在浏览器里演示"为什么某条消息会被转发/被拦截"；
 *  - 不连接任何平台、不读取真实配置、不发送任何消息、不做任何持久化；
 *  - 真实判定以仓库源码为准。
 *
 * 所有人类可读文本均为 `{ zh, en }`；技术字段（错误码/状态/配置键）保持英文。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PolicyDemo = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SUPPORTED_KINDS = ["text"];
  const RISK_NOTICE_VERSION = "2026-10-18.v1";
  const text = (zh, en) => ({ zh, en });

  // ── 出境闸门 ──────────────────────────────────────────────────────────
  function evaluateCrossBorderGate(settings) {
    const reasons = [];
    if (!settings.enabled) reasons.push(text("telegramCrossBorder.enabled = false（默认关闭）", "telegramCrossBorder.enabled = false (off by default)"));
    if (!settings.operator || settings.operator.trim() === "") reasons.push(text("缺少 operator（开通者署名）", "missing operator (who enabled it)"));
    if (!settings.acknowledgedAt) reasons.push(text("缺少 acknowledgedAt（确认时间戳）", "missing acknowledgedAt (ISO 8601 timestamp)"));
    else if (Number.isNaN(Date.parse(settings.acknowledgedAt))) reasons.push(text("acknowledgedAt 不是合法 ISO 8601 时间", "acknowledgedAt is not a valid ISO 8601 timestamp"));
    if (!settings.selfMessagesOnlyConfirmed) reasons.push(text("selfMessagesOnlyConfirmed = false（未确认仅转发本人消息）", "selfMessagesOnlyConfirmed = false (own messages only not confirmed)"));
    if (settings.riskNoticeVersion !== RISK_NOTICE_VERSION) reasons.push(text("riskNoticeVersion 与当前告知版本不一致", "riskNoticeVersion does not match the current notice version"));
    return { open: reasons.length === 0, reasons };
  }

  // ── 路由结构 / 矩阵编译 ───────────────────────────────────────────────
  function checkRouteShape(route) {
    const issues = [];
    if (route.from.chatType === "group") {
      issues.push({
        code: route.from.platform === "wechat" ? "WECHAT_GROUP_SOURCE_FORBIDDEN" : "GROUP_CHAT_UNSUPPORTED",
        message:
          route.from.platform === "wechat"
            ? text("微信侧不允许群聊（硬约束）", "WeChat group chats are forbidden (hard rule)")
            : text("本项目不支持任何平台的群聊", "Group chats are unsupported on every platform"),
      });
    }
    for (const target of route.to) {
      if (target.chatType === "group") {
        issues.push({
          code: target.platform === "wechat" ? "WECHAT_GROUP_TARGET_FORBIDDEN" : "GROUP_CHAT_UNSUPPORTED",
          message: text("群聊目标不受支持", "Group-chat target is unsupported"),
        });
      }
    }
    if (route.to.some((t) => t.platform === route.from.platform && t.conversationId === route.from.conversationId && t.chatType === route.from.chatType)) {
      issues.push({ code: "ROUTE_SELF_LOOP", message: text("源与目标相同（自环）", "source and target are identical (self-loop)") });
    }
    return issues;
  }

  function edgeKey(route) {
    return `${route.from.platform}:${route.from.conversationId}:${route.from.chatType}`;
  }
  function targetKey(target) {
    return `${target.platform}:${target.conversationId}:${target.chatType}`;
  }

  function findCycles(edges) {
    const state = new Map();
    const nodes = [];
    const stack = [];
    const found = new Map();
    const visit = (node) => {
      state.set(node, 1);
      nodes.push(node);
      for (const edge of edges.get(node) || []) {
        const next = state.get(edge.to) || 0;
        if (next === 0) {
          stack.push(edge);
          visit(edge.to);
          stack.pop();
        } else if (next === 1) {
          const at = nodes.lastIndexOf(edge.to);
          if (at >= 0) {
            const ring = [...nodes.slice(at), edge.to];
            const groups = [...new Set([...stack.slice(at).map((e) => e.group), edge.group])];
            const min = ring.slice(0, -1).reduce((best, item, index) => (item < ring[best] ? index : best), 0);
            const key = [...ring.slice(0, -1).slice(min), ...ring.slice(0, -1).slice(0, min)].join("→");
            if (!found.has(key)) found.set(key, { nodes: ring, groups, crossGroup: groups.length > 1 });
          }
        }
      }
      nodes.pop();
      state.set(node, 2);
    };
    for (const node of edges.keys()) if ((state.get(node) || 0) === 0) visit(node);
    return [...found.values()];
  }

  /**
   * 简化版路由矩阵编译（镜像 src/routing/matrix.ts + preflight 的主要规则）。
   * options: { gate, consentEnabled, loopGuardEnabled }
   */
  function compileMatrix(routes, options) {
    const opts = options || {};
    const gate = opts.gate || { enabled: false };
    const consentEnabled = Boolean(opts.consentEnabled);
    const loopGuardEnabled = opts.loopGuardEnabled !== false;
    const issues = [];
    const seenIds = new Set();
    const seenEdges = new Set();
    const groups = new Map();
    const edges = new Map();
    let edgeCount = 0;
    let crossBorder = 0;
    let thirdParty = 0;

    for (const route of routes) {
      const label = route.id || text("（未命名）", "(unnamed)");
      const shape = checkRouteShape(route);
      for (const item of shape) issues.push({ ...item, routeId: route.id });

      if (seenIds.has(route.id)) {
        issues.push({ code: "DUPLICATE_ROUTE_ID", message: text(`路由 id 重复：${route.id}`, `duplicate route id: ${route.id}`), routeId: route.id });
      }
      seenIds.add(route.id);

      const owner = groups.get(route.group);
      if (owner && owner !== route.contentOwner) {
        issues.push({
          code: "GROUP_CONTENT_OWNER_CONFLICT",
          message: text(`group "${route.group}" 内 contentOwner 不一致`, `group "${route.group}" mixes contentOwner values`),
          routeId: route.id,
        });
      }
      groups.set(route.group, route.contentOwner);

      const from = edgeKey(route);
      for (const target of route.to) {
        edgeCount += 1;
        const signature = `${from}->${targetKey(target)}`;
        if (seenEdges.has(signature)) {
          issues.push({ code: "DUPLICATE_EDGE", message: text(`重复路由边 ${signature}`, `duplicate edge ${signature}`), routeId: route.id });
        }
        seenEdges.add(signature);
        const list = edges.get(from) || [];
        list.push({ to: targetKey(target), group: route.group });
        edges.set(from, list);
      }

      if (route.to.some((t) => t.platform === "telegram")) crossBorder += 1;
      if (route.contentOwner === "third-party") thirdParty += 1;
      if (route.contentOwner === "third-party" && !consentEnabled) {
        issues.push({
          code: "THIRD_PARTY_CONSENT_DISABLED",
          message: text("他人内容路由存在，但 thirdPartyConsent.enabled = false", "third-party route exists but thirdPartyConsent.enabled = false"),
          routeId: route.id,
        });
      }
      void label;
    }

    const cycles = findCycles(edges);
    for (const cycle of cycles) {
      if (cycle.crossGroup) {
        issues.push({ code: "CYCLE_ACROSS_GROUPS", message: text(`路由环跨越多个 group：${cycle.nodes.join(" → ")}`, `cycle spans multiple groups: ${cycle.nodes.join(" → ")}`) });
      }
    }
    if (cycles.length > 0 && !loopGuardEnabled) {
      issues.push({ code: "LOOP_GUARD_REQUIRED", message: text("存在路由环，但 loopGuard.enabled = false", "routes form a cycle but loopGuard.enabled = false") });
    }

    if (crossBorder > 0) {
      const result = evaluateCrossBorderGate(gate);
      if (!result.open) {
        issues.push({
          code: "CROSS_BORDER_GATE_CLOSED",
          message: text(
            `存在 ${crossBorder} 条出境路由，但闸门未完全打开（${result.reasons.map((r) => r.zh).join("；")}）`,
            `${crossBorder} cross-border route(s) exist but the gate is not open (${result.reasons.map((r) => r.en).join("; ")})`,
          ),
        });
      }
    }

    return {
      ok: issues.length === 0,
      exitCode: issues.length === 0 ? 0 : 78,
      issues,
      cycles,
      stats: { routes: routes.length, edges: edgeCount, groups: groups.size, crossBorder, thirdParty },
    };
  }

  // ── 消息决策链 ────────────────────────────────────────────────────────
  function escapeCqCodes(value) {
    return String(value).replace(/&/g, "&amp;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
  }

  function decide(scenario) {
    const steps = [];
    const msg = scenario.msg;
    const route = scenario.route;
    const gate = scenario.gate || {};
    const step = (id, title, status, detail) => {
      steps.push({ id, title, status, detail });
      return status !== "fail";
    };
    const t = (zh, en) => ({ zh, en });

    if (
      !step(
        "P0",
        t("自消息 / 机器人消息过滤", "Self / bot message filter"),
        msg.senderIsSelf || msg.senderIsBot ? "fail" : "pass",
        msg.senderIsSelf ? t("senderIsSelf = true", "senderIsSelf = true") : msg.senderIsBot ? t("senderIsBot = true", "senderIsBot = true") : t("正常用户消息", "regular user message"),
      )
    ) {
      return finish(msg.senderIsSelf ? "skipped_self" : "skipped_bot", t("丢弃：自身/机器人消息", "Dropped: self or bot message"), steps, msg);
    }
    if (
      !step(
        "P1",
        t("群聊硬门（任何平台都不支持）", "Group-chat hard gate (no platform supported)"),
        msg.chatType === "private" ? "pass" : "fail",
        msg.chatType === "private" ? t("chatType = private", "chatType = private") : t("chatType = group", "chatType = group"),
      )
    ) {
      return finish("skipped_group_forbidden", t("丢弃：群聊消息（无配置开关可放开）", "Dropped: group chat (no switch can enable it)"), steps, msg);
    }
    const matched = Boolean(route) && route.from.conversationId === msg.conversationId;
    if (
      !step(
        "P2",
        t("路由矩阵命中", "Routing matrix match"),
        matched ? "pass" : "fail",
        matched ? t(`命中路由 ${route.id}`, `matched route ${route.id}`) : t("源会话不在路由表中", "source conversation is not in the routing table"),
      )
    ) {
      return finish("skipped_no_route", t("忽略：没有匹配的路由", "Ignored: no matching route"), steps, msg);
    }
    if (!step("P3", t("回显 messageId / hop 预算", "Echo messageId / hop budget"), scenario.loopEcho ? "fail" : "pass", scenario.loopEcho ? t("messageId 命中回显表（hop+1 > maxHops）", "messageId hit the echo table (hop+1 > maxHops)") : t("非回显消息", "not an echo"))) {
      return finish("skipped_loop_suspected", t("丢弃：检测到回环", "Dropped: loop suspected"), steps, msg);
    }
    const kindOk = SUPPORTED_KINDS.includes(msg.kind);
    if (!step("P4", t("消息类型白名单（仅文本）", "Message-kind allow-list (text only)"), kindOk ? "pass" : "fail", kindOk ? t("kind = text", "kind = text") : t(`kind = ${msg.kind}（不支持，显式回执后跳过）`, `kind = ${msg.kind} (unsupported: explicit notice, then skipped)`))) {
      return finish("skipped_unsupported_kind", t("跳过：不支持的消息类型（已向源会话回执）", "Skipped: unsupported kind (notice sent to the source conversation)"), steps, msg);
    }
    const cross = route.to.some((target) => target.platform === "telegram");
    if (cross) {
      const result = evaluateCrossBorderGate(gate);
      if (!step("P5", t("数据出境闸门（PIPL 第 38/39 条）", "Cross-border gate (PIPL Art. 38/39)"), result.open ? "pass" : "fail", result.open ? t("五要素齐备", "all five confirmations present") : { zh: result.reasons.map((r) => r.zh).join("；"), en: result.reasons.map((r) => r.en).join("; ") })) {
        return finish("blocked_cross_border", t("阻断：出境闸门未打开（启动前置检查会直接 exit 78）", "Blocked: cross-border gate closed (preflight exits 78)"), steps, msg);
      }
    } else {
      step("P5", t("数据出境闸门（PIPL 第 38/39 条）", "Cross-border gate (PIPL Art. 38/39)"), "na", t("目标均在境内，不涉及出境", "all targets are domestic, no cross-border transfer"));
    }
    step("P6", t("短期内容指纹回环", "Short-lived content fingerprint"), "na", t("演示环境无历史出站指纹", "no outbound fingerprints in this demo"));
    if (route.contentOwner === "third-party") {
      if (!step("P7", t("他人内容告知—同意（PIPL 第 23 条）", "Third-party content notice-and-consent (PIPL Art. 23)"), scenario.consentGranted ? "pass" : "fail", scenario.consentGranted ? t("已有该链路的同意记录", "consent recorded for this route") : t("未取得同意，发送告知后阻断", "no consent yet: notice sent, forwarding blocked"))) {
        return finish("blocked_consent_pending", t("阻断：等待对方回复「同意转发」", "Blocked: waiting for the other party to agree"), steps, msg);
      }
    } else {
      step("P7", t("他人内容告知—同意（PIPL 第 23 条）", "Third-party content notice-and-consent (PIPL Art. 23)"), "na", t("contentOwner = self，仅本人消息", "contentOwner = self, own messages only"));
    }
    const target = route.to[0];
    const rendered = target.platform === "qq" ? escapeCqCodes(msg.text) : msg.text;
    step("P8", t("文本转换（CQ 转义 / 截断）", "Text transform (CQ escaping / truncation)"), "pass", target.platform === "qq" ? t("已按目标平台转义 CQ 码", "CQ codes escaped for the target platform") : t("纯文本直传", "plain text passthrough"));

    return {
      status: "forwarded",
      title: t(`转发：${msg.platform} → ${target.platform}（模拟发送成功）`, `Forwarded: ${msg.platform} → ${target.platform} (simulated success)`),
      steps,
      log: logOf(msg, route, "forwarded", target.platform, 42),
      sentPayload: { platform: target.platform, conversationId: "(demo: real IDs are hidden)", segments: [{ type: "text", text: rendered }] },
      notice: null,
    };
  }

  function finish(status, title, steps, msg) {
    const notice =
      status === "skipped_unsupported_kind"
        ? {
            zh: "本条消息的类型暂不支持跨平台转发，已跳过。本工具只转发文本消息。",
            en: "This message type cannot be forwarded across platforms and was skipped. Only text is supported.",
          }
        : status === "blocked_consent_pending"
          ? {
              zh: "【转发告知】本条消息默认不会转发；若你同意，请回复「同意转发」。（演示文案，真实文案含接收方名称/联系方式/目的/方式/种类/期限）",
              en: "[Forwarding notice] This message is not forwarded by default. If you agree, reply with the consent keyword. (Demo text; the real notice includes receiver name, contact, purpose, method, categories and retention.)",
            }
          : null;
    return { status, title, steps, log: logOf(msg, null, status, null, null), sentPayload: null, notice };
  }

  function logOf(msg, route, status, targetPlatform, latencyMs) {
    const record = { ts: "2026-10-21T09:00:00.000Z", level: status === "forwarded" ? "info" : "warn", event: "forward", status, sourcePlatform: msg.platform };
    if (route) record.routeId = route.id;
    if (targetPlatform) record.targetPlatform = targetPlatform;
    if (typeof latencyMs === "number") record.latencyMs = latencyMs;
    return record;
  }

  // ── 数据 ──────────────────────────────────────────────────────────────
  const routes = {
    wxSelfToQq: {
      id: "wx-private-to-qq",
      group: "self-wx-qq",
      contentOwner: "self",
      from: { platform: "wechat", conversationId: "wxid_demo_account", chatType: "private" },
      to: [{ platform: "qq", conversationId: "10001", chatType: "private" }],
    },
    wxGroup: {
      id: "wx-group-route",
      group: "bad",
      contentOwner: "self",
      from: { platform: "wechat", conversationId: "wxid_demo_account", chatType: "group" },
      to: [{ platform: "qq", conversationId: "10001", chatType: "private" }],
    },
    wxToTelegram: {
      id: "wx-private-to-telegram",
      group: "self-wx-tg",
      contentOwner: "self",
      from: { platform: "wechat", conversationId: "wxid_demo_account", chatType: "private" },
      to: [{ platform: "telegram", conversationId: "123456789", chatType: "private" }],
    },
    thirdParty: {
      id: "colleague-wx-to-qq",
      group: "third-party-demo",
      contentOwner: "third-party",
      from: { platform: "wechat", conversationId: "wxid_demo_account", chatType: "private" },
      to: [{ platform: "qq", conversationId: "10002", chatType: "private" }],
    },
  };

  const baseMsg = {
    platform: "wechat",
    conversationId: "wxid_demo_account",
    chatType: "private",
    kind: "text",
    text: "晚上七点老地方见",
    senderIsSelf: false,
    senderIsBot: false,
  };

  const scenarios = [
    { id: "normal", label: text("正常：微信私聊 → QQ", "Normal: WeChat private → QQ"), desc: text("自己与自己账号之间的文本消息", "Text between your own accounts"), route: routes.wxSelfToQq, msg: baseMsg },
    { id: "group", label: text("微信群聊消息", "WeChat group message"), desc: text("微信群聊一律拒绝，无配置开关", "Group chats are always rejected, no switch"), route: routes.wxGroup, msg: { ...baseMsg, chatType: "group" } },
    { id: "media", label: text("图片消息", "Image message"), desc: text("只支持文本；媒体显式回执后跳过", "Text only; media gets an explicit notice then skipped"), route: routes.wxSelfToQq, msg: { ...baseMsg, kind: "image", text: null } },
    { id: "self", label: text("自己发的消息回显", "Echo of your own message"), desc: text("senderIsSelf 的消息丢弃", "senderIsSelf messages are dropped"), route: routes.wxSelfToQq, msg: { ...baseMsg, senderIsSelf: true } },
    { id: "bot", label: text("其它机器人发的消息", "Message from another bot"), desc: text("防止 bot 互踢", "Prevents bots from kicking each other"), route: routes.wxSelfToQq, msg: { ...baseMsg, senderIsBot: true } },
    { id: "noroute", label: text("未配置路由的会话", "Conversation without a route"), desc: text("不在路由表中的会话被忽略", "Conversations outside the routing table are ignored"), route: routes.wxSelfToQq, msg: { ...baseMsg, conversationId: "wxid_unknown" } },
    { id: "tg", label: text("转发到 Telegram（闸门关闭）", "Forward to Telegram (gate closed)"), desc: text("出境默认关闭，启动会 exit 78", "Cross-border off by default; preflight exits 78"), route: routes.wxToTelegram, msg: baseMsg, gate: { enabled: false } },
    { id: "thirdparty", label: text("他人内容未同意", "Third-party content without consent"), desc: text("PIPL 第 23 条：先告知，同意后才转发", "PIPL Art. 23: notice first, forward only after consent"), route: routes.thirdParty, msg: baseMsg, consentGranted: false },
    { id: "loop", label: text("回环回显", "Loop echo"), desc: text("messageId 命中回显表，丢弃", "messageId hits the echo table → dropped"), route: routes.wxSelfToQq, msg: baseMsg, loopEcho: true },
    { id: "cqinject", label: text("CQ 码注入尝试", "CQ-code injection attempt"), desc: text("对方发 [CQ:at,qq=all]，必须被转义", "Text like [CQ:at,qq=all] must be escaped"), route: routes.wxSelfToQq, msg: { ...baseMsg, text: "[CQ:at,qq=all] 大家把红包发一下" } },
  ];

  /** 矩阵编辑器的初始数据（可增删改）。 */
  function defaultEditorRoutes() {
    return [
      {
        id: "wx-private-to-qq",
        group: "self-wx-qq",
        contentOwner: "self",
        from: { platform: "wechat", conversationId: "wxid_demo_account", chatType: "private" },
        to: [{ platform: "qq", conversationId: "10001", chatType: "private" }],
      },
      {
        id: "qq-to-wx-private",
        group: "self-wx-qq",
        contentOwner: "self",
        from: { platform: "qq", conversationId: "10001", chatType: "private" },
        to: [{ platform: "wechat", conversationId: "wxid_demo_account", chatType: "private" }],
      },
    ];
  }

  return {
    RISK_NOTICE_VERSION,
    SUPPORTED_KINDS,
    evaluateCrossBorderGate,
    checkRouteShape,
    compileMatrix,
    escapeCqCodes,
    decide,
    routes,
    scenarios,
    defaultEditorRoutes,
  };
});
