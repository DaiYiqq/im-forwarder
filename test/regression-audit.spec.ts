/**
 * 独立审计（docs/AUDIT.md）发现项的回归测试。
 *
 * 每条用例对应报告里的一个具体发现，确保"修了而且锁住"：
 *   · F1：平台域名黑名单可被尾随点绕过（中低）
 *   · F3：同意粒度实际是"会话"，一次同意会覆盖同会话的其它接收方（低）
 *
 * 说明：F2（本地同意文件可伪造）、F4/F6/F7（信任边界）属于"无法在代码内消除"的
 * 问题，已在 COMPLIANCE.md 的残留风险中逐条披露，因此不写成测试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ConsentService } from "../src/compliance/consent";
import { ConsentStore } from "../src/compliance/consent-store";
import { directPlatformHostViolation, hostnameOf } from "../src/compliance/gates";
import {
  FIXED_NOW,
  endpoint,
  fakeGateway,
  hasViolation,
  incoming,
  makeConfig,
  makeForwarder,
  preflightFromRaw,
  rawConfig,
  receiverNotice,
  route,
  target,
} from "./fixtures/harness";

// ─────────────────────────────────────────────────────────────────────────────
// F1：域名黑名单必须对"尾随点"等等价写法同样生效
// ─────────────────────────────────────────────────────────────────────────────

test("F1：hostnameOf 会去掉尾随点并小写化（等价域名不得逃逸）", () => {
  assert.equal(hostnameOf("https://ilinkai.weixin.qq.com./api"), "ilinkai.weixin.qq.com");
  assert.equal(hostnameOf("https://ILINKAI.WEIXIN.QQ.COM./api"), "ilinkai.weixin.qq.com");
  assert.equal(hostnameOf("https://api.telegram.org.../x"), "api.telegram.org");
  // 非平台域名不应被误伤
  assert.equal(hostnameOf("http://127.0.0.1:18080"), "127.0.0.1");
  assert.equal(hostnameOf("not a url"), null);
});

test("F1：给 baseUrl 加尾随点仍然会被判定为直连平台", () => {
  const variants = [
    "https://ilinkai.weixin.qq.com./api",
    "https://ilinkai.weixin.qq.com/api",
    "https://api.telegram.org./bot",
    "https://weixin.qq.com./",
  ];
  for (const url of variants) {
    const violation = directPlatformHostViolation(url);
    assert.notEqual(violation, null, `${url} 必须命中直连平台黑名单（否则 Bearer Token 可能被发往平台域名）`);
  }
  assert.equal(directPlatformHostViolation("http://127.0.0.1:18080"), null, "网关地址不得被误伤");
});

test("F1：preflight 对尾随点写法同样拒绝启动（DIRECT_PLATFORM_ENDPOINT）", () => {
  const routes = [
    route({ id: "wx-to-qq", from: endpoint("wechat", "wxid_self"), to: [target("qq", "10001")] }),
  ];
  const { report } = preflightFromRaw(
    rawConfig(routes, { gateway: { baseUrl: "https://ilinkai.weixin.qq.com./api" } }),
  );
  assert.equal(report.ok, false, "绕过网关直连微信官方域名必须拒绝启动");
  assert.ok(
    hasViolation(report, "DIRECT_PLATFORM_ENDPOINT"),
    `期望命中 DIRECT_PLATFORM_ENDPOINT，实际：${report.violations.map((item) => item.code).join(",")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F3：同意必须按链路（route）生效，而不是按会话一次性覆盖
// ─────────────────────────────────────────────────────────────────────────────

test("F3：一次「同意转发」不得同时授权同会话的其它接收方（多链路需各自同意）", async () => {
  const routes = [
    route({
      id: "route-qq",
      group: "tp-1",
      contentOwner: "third-party",
      from: endpoint("wechat", "wxid_colleague"),
      to: [target("qq", "10002", "private", receiverNotice({ name: "QQ 接收方 A" }))],
    }),
    route({
      id: "route-qq2",
      group: "tp-2",
      contentOwner: "third-party",
      from: endpoint("wechat", "wxid_colleague"),
      to: [target("qq", "10003", "private", receiverNotice({ name: "QQ 接收方 B" }))],
    }),
  ];

  const config = makeConfig(routes, {
    compliance: { thirdPartyConsent: { enabled: true, noticeCooldownMs: 0 } },
  });
  const store = ConsentStore.inMemory(() => FIXED_NOW);
  const consent = new ConsentService(store, config.compliance.thirdPartyConsent, () => FIXED_NOW);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({ config, gateway: gateway.client, consent });

  // 1) 未同意：一条都不转发
  const before = await forwarder.handle(
    incoming({ conversationId: "wxid_colleague", messageId: "m1", text: "hello" }),
  );
  assert.deepEqual(before, ["blocked_consent_pending", "blocked_consent_pending"]);
  assert.equal(
    gateway.sent.filter((request) => request.platform === "qq").length,
    0,
    "未取得同意前不得向任何接收方发送内容",
  );

  // 2) 回复同意：只覆盖被展示告知的那条链路（route-qq）
  const granted = await forwarder.handle(
    incoming({ conversationId: "wxid_colleague", messageId: "m2", text: "同意转发" }),
  );
  assert.deepEqual(granted, ["consent_recorded"]);
  const scope = { platform: "wechat" as const, conversationId: "wxid_colleague" };
  assert.equal(consent.hasGrant(scope, "domestic", "route-qq"), true);
  assert.equal(
    consent.hasGrant(scope, "domestic", "route-qq2"),
    false,
    "同一会话的另一条他人内容链路不能被顺带授权（否则告知范围 ≠ 实际授权范围）",
  );

  // 3) 再发消息：route-qq 转发，route-qq2 仍被阻断并要求单独同意
  const after = await forwarder.handle(
    incoming({ conversationId: "wxid_colleague", messageId: "m3", text: "world" }),
  );
  assert.ok(after.includes("forwarded"), `期望包含 forwarded，实际：${after.join(",")}`);
  assert.ok(after.includes("blocked_consent_pending"));
  const forwardedTargets = gateway.sent
    .filter((request) => request.platform === "qq" && request.segments[0]?.text === "world")
    .map((request) => request.conversationId);
  assert.deepEqual(forwardedTargets, ["10002"], "只允许发往已同意的那条链路的目标");
});
