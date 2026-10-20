/**
 * 回环防护（test/loop-guard.spec.ts）。
 *
 * 目标：证明 A → B → A 的回流在三种机制下都能被拦住
 *   1. 回显 messageId 层（网关返回 messageId 时最可靠）；
 *   2. hop 预算（maxHops）——默认 1 表示"转发过的消息不再二次转发"；
 *   3. 短期内容指纹（网关不返回 messageId 时的兜底）。
 *
 * 回环防护失效意味着两个平台之间无限刷屏，属于必须挡住的功能性+合规性缺陷。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  endpoint,
  fakeGateway,
  incoming,
  loopGuardFromConfig,
  makeConfig,
  makeForwarder,
  makeLoopGuard,
  route,
  target,
} from "./fixtures/harness";

/** 默认双向链路：微信私聊 ↔ QQ 指定会话（与 config.example.yaml 同构）。 */
const bidirectionalRoutes = [
  route({
    id: "wx-private-to-qq",
    group: "self-wx-qq",
    from: endpoint("wechat", "wxid_self"),
    to: [target("qq", "10001")],
  }),
  route({
    id: "qq-to-wx-private",
    group: "self-wx-qq",
    from: endpoint("qq", "10001"),
    to: [target("wechat", "wxid_self")],
  }),
];

test("messageId 回显层：A→B 后目标侧用同一 messageId 回流 → skipped_loop_suspected 且不再发送", async () => {
  const config = makeConfig(bidirectionalRoutes);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    loopGuard: loopGuardFromConfig(config),
  });

  const first = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_self", messageId: "in-wx-1", text: "hello-loop" }),
  );
  assert.deepEqual(first, ["forwarded"]);
  assert.equal(gateway.sent.length, 1);
  assert.equal(gateway.sent[0]?.platform, "qq");
  assert.equal(gateway.sent[0]?.segments[0]?.text, "hello-loop");

  // 用"目标侧返回的 messageId"伪造一条 QQ 入站消息（真实回环就是这样产生的）
  const echoed = await forwarder.handle(
    incoming({
      platform: "qq",
      conversationId: "10001",
      messageId: "fake-msg-1",
      senderId: "qq-user",
      text: "relayed-different-text",
    }),
  );
  assert.deepEqual(
    echoed,
    ["skipped_loop_suspected"],
    "合规要求：本服务自己发出的消息若被网关回推，必须被识别为回显并丢弃",
  );
  assert.equal(gateway.sent.length, 1, "回环消息不得产生任何新的发送");
});

test("hop 预算 maxHops=2 时允许再转发一次（预算确实生效，而不是无条件丢弃）", async () => {
  const config = makeConfig(bidirectionalRoutes, {
    compliance: { loopGuard: { enabled: true, maxHops: 2 } },
  });
  const gateway = fakeGateway();
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    loopGuard: loopGuardFromConfig(config),
  });

  const first = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_self", messageId: "in-wx-1", text: "hop-budget" }),
  );
  assert.deepEqual(first, ["forwarded"]);

  const echoed = await forwarder.handle(
    incoming({
      platform: "qq",
      conversationId: "10001",
      messageId: "fake-msg-1",
      text: "relayed-next-hop",
    }),
  );
  assert.deepEqual(echoed, ["forwarded"], "maxHops=2 时回显消息应被允许再转发一次");
  assert.equal(gateway.sent.length, 2);
  assert.equal(gateway.sent[1]?.platform, "wechat");
  assert.equal(gateway.sent[1]?.conversationId, "wxid_self");
});

test("指纹兜底层：网关不返回 messageId 时，窗口内同文本回流仍被拦截", async () => {
  const config = makeConfig(bidirectionalRoutes, {
    compliance: { loopGuard: { enabled: true, fingerprintWindowMs: 60_000 } },
  });
  const gateway = fakeGateway({ messageIds: "none" });
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    loopGuard: loopGuardFromConfig(config),
  });

  const first = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_self", messageId: "in-wx-1", text: "fingerprint-payload" }),
  );
  assert.deepEqual(first, ["forwarded"]);
  assert.equal(gateway.sent.length, 1);

  const echoed = await forwarder.handle(
    incoming({ platform: "qq", conversationId: "10001", messageId: "in-qq-1", text: "fingerprint-payload" }),
  );
  assert.deepEqual(
    echoed,
    ["skipped_loop_suspected"],
    "合规要求：即使网关不返回 messageId，窗口内同文本回流也必须被指纹层拦住",
  );
  assert.equal(gateway.sent.length, 1, "指纹命中后不得再发送");
});

test("LoopGuard 关闭时 lookupEcho 永远返回 none（关闭即完全不做回环判定）", () => {
  const loopGuard = makeLoopGuard({ enabled: false });

  loopGuard.rememberEcho("qq", "10001", "fake-msg-1", "self-wx-qq", 1);
  loopGuard.rememberFingerprint("self-wx-qq", "fingerprint-payload");

  assert.deepEqual(
    loopGuard.lookupEcho({ platform: "qq", conversationId: "10001", messageId: "fake-msg-1" }),
    { kind: "none" },
    "enabled=false 时不得残留任何回显拦截",
  );
  assert.equal(
    loopGuard.isFingerprintLoop("self-wx-qq", { text: "fingerprint-payload" }),
    false,
    "enabled=false 时指纹层也必须关闭",
  );
});
