/**
 * 在线 Demo 的策略镜像自检（Node 直接运行，无需浏览器）：
 *   node demo/policy-demo.test.mjs
 *
 * 目的：保证 Demo 展示的判定与源码行为一致，避免"演示说会拦、实际没拦"。
 */

import assert from "node:assert/strict";

// 仓库根 package.json 是 "type": "module"，demo/policy-demo.js 会被当作 ESM 执行；
// 它的 UMD 包装会把 API 挂到 globalThis.PolicyDemo（浏览器里同样是 <script> 全局）。
await import("./policy-demo.js");
const demo = globalThis.PolicyDemo;
assert.ok(demo, "PolicyDemo 未挂载到 globalThis");

const byId = (id) => demo.scenarios.find((scenario) => scenario.id === id);

// 1) 正常私聊文本 → forwarded，且日志只有白名单字段
const normal = demo.decide(byId("normal"));
assert.equal(normal.status, "forwarded");
assert.deepEqual(Object.keys(normal.log).sort(), [
  "event",
  "latencyMs",
  "level",
  "routeId",
  "sourcePlatform",
  "status",
  "targetPlatform",
  "ts",
]);

// 2) 群聊在任何平台都被拒绝
assert.equal(demo.decide(byId("group")).status, "skipped_group_forbidden");
assert.ok(demo.checkRouteShape(demo.routes.wxGroup).some((error) => error.startsWith("WECHAT_GROUP_SOURCE_FORBIDDEN")));

// 3) 群聊目标同样拒绝（换一个平台验证）
assert.ok(
  demo
    .checkRouteShape({
      from: { platform: "wechat", conversationId: "a", chatType: "private" },
      to: [{ platform: "qq", conversationId: "1", chatType: "group" }],
    })
    .some((error) => error.startsWith("GROUP_CHAT_UNSUPPORTED")),
);

// 4) 媒体被显式跳过且生成回执文案
const media = demo.decide(byId("media"));
assert.equal(media.status, "skipped_unsupported_kind");
assert.ok(media.notice && media.notice.includes("不支持"));

// 5) 自身/机器人消息丢弃
assert.equal(demo.decide(byId("self")).status, "skipped_self");
assert.equal(demo.decide(byId("bot")).status, "skipped_bot");

// 6) 无路由忽略
assert.equal(demo.decide(byId("noroute")).status, "skipped_no_route");

// 7) 出境闸门关闭 → 阻断；五要素齐备 → 放行
assert.equal(demo.decide(byId("tg")).status, "blocked_cross_border");
const openGate = {
  enabled: true,
  operator: "演示",
  acknowledgedAt: "2026-10-21T09:00:00+08:00",
  selfMessagesOnlyConfirmed: true,
  riskNoticeVersion: demo.RISK_NOTICE_VERSION,
};
assert.equal(demo.evaluateCrossBorderGate(openGate).open, true);
assert.equal(demo.decide({ ...byId("tg"), gate: openGate }).status, "forwarded");
assert.equal(demo.evaluateCrossBorderGate({ ...openGate, selfMessagesOnlyConfirmed: false }).open, false);

// 8) 他人内容未同意 → 阻断；同意后 → 转发
assert.equal(demo.decide(byId("thirdparty")).status, "blocked_consent_pending");
assert.equal(demo.decide({ ...byId("thirdparty"), consentGranted: true }).status, "forwarded");

// 9) 回环丢弃
assert.equal(demo.decide(byId("loop")).status, "skipped_loop_suspected");

// 10) CQ 注入必须被转义，且不残留裸 [CQ:
const injected = demo.decide(byId("cqinject"));
assert.equal(injected.status, "forwarded");
const sentText = injected.sentPayload.segments[0].text;
assert.ok(!sentText.includes("[CQ:"), "转义后不得残留裸 [CQ:");
assert.ok(sentText.includes("&#91;CQ:at,qq=all&#93;"));

console.log(`[demo] policy mirror self-test passed: ${demo.scenarios.length} scenarios, 10 assertions groups`);
