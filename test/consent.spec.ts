/**
 * 告知—同意流程（test/consent.spec.ts）—— PIPL 第 23 条 / 第 39 条。
 *
 * 关键性质（缺一不可）：
 *  - 未同意前不转发，只给**源会话**发告知，目标会话零发送；
 *  - 同意必须是对方会话的独立一条消息，且这条指令本身不被转发；
 *  - 出境需要两次独立同意（境内转发同意 + 单独同意出境）；
 *  - 同意可撤回，撤回后不再转发；
 *  - 同意记录带 TTL，过期自动失效。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ConsentService } from "../src/compliance/consent";
import { ConsentStore } from "../src/compliance/consent-store";

import {
  DAY_MS,
  endpoint,
  fakeGateway,
  FIXED_NOW,
  incoming,
  loopGuardFromConfig,
  makeConfig,
  makeForwarder,
  matrixOf,
  receiverNotice,
  route,
  silentLogger,
  target,
} from "./fixtures/harness";

const thirdPartySettings = {
  enabled: true,
  persist: false,
  allowCrossBorder: false,
  noticeCooldownMs: 0,
  ttlDays: 30,
};

function domesticRoutes() {
  return [
    route({
      id: "third-party-wx-to-qq",
      group: "third-party-demo",
      contentOwner: "third-party",
      from: endpoint("wechat", "wxid_colleague"),
      to: [target("qq", "10002", "private", receiverNotice())],
    }),
  ];
}

function crossBorderRoutes() {
  return [
    route({
      id: "third-party-wx-to-tg",
      group: "third-party-tg",
      contentOwner: "third-party",
      from: endpoint("wechat", "wxid_colleague"),
      to: [target("telegram", "123456789", "private", receiverNotice())],
    }),
  ];
}

test("境内 third-party：未同意 → 仅源会话告知；同意 → 转发；撤回 → 停止转发", async () => {
  const config = makeConfig(domesticRoutes(), { compliance: { thirdPartyConsent: thirdPartySettings } });
  const store = ConsentStore.inMemory(() => FIXED_NOW);
  const consent = new ConsentService(store, config.compliance.thirdPartyConsent, () => FIXED_NOW);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    matrix: matrixOf(config),
    consent,
    loopGuard: loopGuardFromConfig(config),
    logger: silentLogger(),
  });

  // ── 1. 首条消息：未同意，只发告知 ────────────────────────────────────────
  const first = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "c-1", text: "第一条消息正文" }),
  );
  assert.deepEqual(first, ["blocked_consent_pending"], "未取得同意前必须阻断转发");
  assert.equal(gateway.sent.length, 1, "首条消息只应产生一条告知");
  assert.equal(gateway.sent[0]?.platform, "wechat", "告知只能发回源会话");
  assert.equal(gateway.sent[0]?.conversationId, "wxid_colleague");
  assert.equal(
    gateway.sent.filter((request) => request.platform === "qq").length,
    0,
    "合规要求：未同意前目标会话必须是零发送",
  );

  // ── 2. 对方回复「同意转发」：记录同意，且指令本身不被转发 ────────────────
  const grant = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "c-2", text: "同意转发" }),
  );
  assert.deepEqual(grant, ["consent_recorded"]);
  assert.equal(consent.hasGrant({ platform: "wechat", conversationId: "wxid_colleague" }, "domestic"), true);
  assert.equal(
    gateway.sent.filter((request) => request.platform === "qq").length,
    0,
    "合规要求：「同意转发」这条指令本身不得被当作消息内容转发给对方",
  );
  assert.ok(
    gateway.sent.every((request) => request.platform === "wechat"),
    "同意流程的所有回执都只能发回源会话",
  );

  // ── 3. 同意之后的普通消息：正常转发 ──────────────────────────────────────
  const forwarded = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "c-3", text: "同意之后的正文" }),
  );
  assert.deepEqual(forwarded, ["forwarded"]);
  assert.equal(gateway.sent.filter((request) => request.platform === "qq").length, 1);
  const forwardedRequest = gateway.sent[gateway.sent.length - 1];
  assert.equal(forwardedRequest?.platform, "qq");
  assert.equal(forwardedRequest?.conversationId, "10002");

  // ── 4. 回复「撤回同意」：删除记录 ────────────────────────────────────────
  const revoked = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "c-4", text: "撤回同意" }),
  );
  assert.deepEqual(revoked, ["consent_revoked"]);
  assert.equal(consent.hasGrant({ platform: "wechat", conversationId: "wxid_colleague" }, "domestic"), false);

  // ── 5. 撤回后：不再转发 ──────────────────────────────────────────────────
  const afterRevoke = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "c-5", text: "撤回之后的正文" }),
  );
  assert.deepEqual(afterRevoke, ["blocked_consent_pending"], "撤回同意后必须立即停止转发");
  assert.equal(
    gateway.sent.filter((request) => request.platform === "qq").length,
    1,
    "撤回后不得再产生任何目标会话发送",
  );
});

test("同意指令必须整条精确匹配：正文里顺带提到「同意转发」不得触发授权", async () => {
  const config = makeConfig(domesticRoutes(), { compliance: { thirdPartyConsent: thirdPartySettings } });
  const store = ConsentStore.inMemory(() => FIXED_NOW);
  const consent = new ConsentService(store, config.compliance.thirdPartyConsent, () => FIXED_NOW);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    matrix: matrixOf(config),
    consent,
    loopGuard: loopGuardFromConfig(config),
  });

  const statuses = await forwarder.handle(
    incoming({
      platform: "wechat",
      conversationId: "wxid_colleague",
      messageId: "c-embedded",
      text: "我同意转发这条消息吗",
    }),
  );

  assert.deepEqual(statuses, ["blocked_consent_pending"], "顺带提及不得被视为有效同意");
  assert.equal(
    consent.hasGrant({ platform: "wechat", conversationId: "wxid_colleague" }, "domestic"),
    false,
    "同意必须先告知、再由对方明确回复，不能从聊天内容里推断",
  );
  assert.equal(gateway.sent.filter((request) => request.platform === "qq").length, 0);
});

test("出境 third-party：需要两次独立同意（境内同意后仍需「同意出境」）", async () => {
  const config = makeConfig(crossBorderRoutes(), {
    compliance: {
      thirdPartyConsent: { ...thirdPartySettings, allowCrossBorder: true },
    },
  });
  const store = ConsentStore.inMemory(() => FIXED_NOW);
  const consent = new ConsentService(store, config.compliance.thirdPartyConsent, () => FIXED_NOW);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    matrix: matrixOf(config),
    consent,
    loopGuard: loopGuardFromConfig(config),
    crossBorderOpen: true,
  });

  // 1. 未同意：阻断，只告知
  assert.deepEqual(
    await forwarder.handle(
      incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "x-1", text: "出境第一条" }),
    ),
    ["blocked_consent_pending"],
  );
  assert.equal(gateway.sent.filter((request) => request.platform === "telegram").length, 0);

  // 2. 境内同意：只记录境内范围
  assert.deepEqual(
    await forwarder.handle(
      incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "x-2", text: "同意转发" }),
    ),
    ["consent_recorded"],
  );
  assert.equal(consent.hasGrant({ platform: "wechat", conversationId: "wxid_colleague" }, "cross-border"), false);

  // 3. 仍被阻断：缺出境单独同意
  assert.deepEqual(
    await forwarder.handle(
      incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "x-3", text: "出境第二条" }),
    ),
    ["blocked_consent_pending"],
    "合规要求：境内同意不等于出境同意（PIPL 第 39 条要求单独同意）",
  );
  assert.equal(
    gateway.sent.filter((request) => request.platform === "telegram").length,
    0,
    "两次同意缺一不可，出境目标不得收到任何内容",
  );

  // 4. 单独同意出境
  assert.deepEqual(
    await forwarder.handle(
      incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "x-4", text: "同意出境" }),
    ),
    ["consent_recorded"],
  );
  assert.equal(consent.hasGrant({ platform: "wechat", conversationId: "wxid_colleague" }, "cross-border"), true);

  // 5. 两次同意齐备：放行
  assert.deepEqual(
    await forwarder.handle(
      incoming({ platform: "wechat", conversationId: "wxid_colleague", messageId: "x-5", text: "出境第三条" }),
    ),
    ["forwarded"],
  );
  assert.equal(gateway.sent.filter((request) => request.platform === "telegram").length, 1);
});

test("同意记录 TTL 过期后失效：过期后必须重新走「告知—同意」", async () => {
  const settings = { ...thirdPartySettings, ttlDays: 1 };
  const config = makeConfig(domesticRoutes(), { compliance: { thirdPartyConsent: settings } });

  let clock = FIXED_NOW;
  const store = ConsentStore.inMemory(() => clock);
  const consent = new ConsentService(store, config.compliance.thirdPartyConsent, () => clock);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    matrix: matrixOf(config),
    consent,
    loopGuard: loopGuardFromConfig(config),
  });

  const scope = { platform: "wechat" as const, conversationId: "wxid_colleague" };

  assert.deepEqual(
    await forwarder.handle(incoming({ ...scope, messageId: "t-1", text: "TTL 第一条" })),
    ["blocked_consent_pending"],
  );
  assert.deepEqual(
    await forwarder.handle(incoming({ ...scope, messageId: "t-2", text: "同意转发" })),
    ["consent_recorded"],
  );
  assert.deepEqual(
    await forwarder.handle(incoming({ ...scope, messageId: "t-3", text: "TTL 第二条" })),
    ["forwarded"],
  );
  assert.equal(gateway.sent.filter((request) => request.platform === "qq").length, 1);

  // 时间跳过一个 TTL（1 天）之后，记录自动失效
  clock += 2 * DAY_MS;
  assert.equal(consent.hasGrant(scope, "domestic"), false, "过期同意不得继续生效");
  assert.deepEqual(
    await forwarder.handle(incoming({ ...scope, messageId: "t-4", text: "TTL 过期后的消息" })),
    ["blocked_consent_pending"],
    "合规要求：同意记录过期后必须重新告知并重新取得同意",
  );
  assert.equal(
    gateway.sent.filter((request) => request.platform === "qq").length,
    1,
    "过期后不得再向目标会话转发",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 同意指令的发送方身份（同一条链路的"谁能同意"）
// ─────────────────────────────────────────────────────────────────────────────

test("本服务自身账号发出的「同意转发」不得被当成他人同意（否则可自我授予转发他人内容的许可）", async () => {
  const config = makeConfig(domesticRoutes(), { compliance: { thirdPartyConsent: thirdPartySettings } });
  const store = ConsentStore.inMemory(() => FIXED_NOW);
  const consent = new ConsentService(store, config.compliance.thirdPartyConsent, () => FIXED_NOW);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    matrix: matrixOf(config),
    consent,
    loopGuard: loopGuardFromConfig(config),
  });

  const scope = { platform: "wechat" as const, conversationId: "wxid_colleague" };

  const statuses = await forwarder.handle(
    incoming({ ...scope, messageId: "self-grant-1", senderIsSelf: true, text: "同意转发" }),
  );

  assert.deepEqual(
    statuses,
    ["skipped_self"],
    "合规要求：senderIsSelf=true 的消息只能被 skipped_self 丢弃，不能进入同意指令分支",
  );
  assert.equal(
    consent.hasGrant(scope, "domestic"),
    false,
    "合规要求：数据主体是该会话的对方，本服务自己的消息不构成「他人同意」",
  );
  assert.equal(
    gateway.sent.filter((request) => request.platform === "qq").length,
    0,
    "未取得真实同意前不得向目标会话转发",
  );
});

test("其它机器人发出的「同意转发」不得被当成他人同意（防止 bot 伪造同意）", async () => {
  const config = makeConfig(domesticRoutes(), { compliance: { thirdPartyConsent: thirdPartySettings } });
  const store = ConsentStore.inMemory(() => FIXED_NOW);
  const consent = new ConsentService(store, config.compliance.thirdPartyConsent, () => FIXED_NOW);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    matrix: matrixOf(config),
    consent,
    loopGuard: loopGuardFromConfig(config),
  });

  const scope = { platform: "wechat" as const, conversationId: "wxid_colleague" };

  const statuses = await forwarder.handle(
    incoming({ ...scope, messageId: "bot-grant-1", senderIsBot: true, text: "同意转发" }),
  );

  assert.deepEqual(
    statuses,
    ["skipped_bot"],
    "合规要求：senderIsBot=true 的消息只能被 skipped_bot 丢弃，不能进入同意指令分支",
  );
  assert.equal(
    consent.hasGrant(scope, "domestic"),
    false,
    "合规要求：机器人消息不构成数据主体的同意",
  );
  assert.equal(gateway.sent.filter((request) => request.platform === "qq").length, 0);
});
