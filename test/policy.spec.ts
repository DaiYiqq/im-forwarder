/**
 * 运行期策略链（test/policy.spec.ts）。
 *
 * 顺序与 fail-closed 语义都在这里钉死：
 *   自消息 → 机器人消息 → 群聊 → 路由 → 回显 → 类型白名单 → 出境兜底 → 指纹 → 同意 → 放行
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideAll } from "../src/routing/policy";
import {
  endpoint,
  fakeGateway,
  incoming,
  makeConfig,
  makeForwarder,
  matrixOf,
  policyContext,
  route,
  target,
} from "./fixtures/harness";

const localRoutes = [
  route({
    id: "wx-private-to-qq",
    group: "self-wx-qq",
    from: endpoint("wechat", "wxid_self"),
    to: [target("qq", "10001")],
  }),
];

function decideLocal(message: ReturnType<typeof incoming>, routes = localRoutes) {
  const config = makeConfig(routes);
  return decideAll(message, matrixOf(config), policyContext(config));
}

test("senderIsSelf=true → skipped_self（防止自己回显被再次转发）", () => {
  const decisions = decideLocal(incoming({ platform: "wechat", conversationId: "wxid_self", senderIsSelf: true }));
  assert.deepEqual(decisions, [{ action: "drop", status: "skipped_self", routeId: null }]);
});

test("senderIsBot=true → skipped_bot（防止两个机器人互相触发形成无限循环）", () => {
  const decisions = decideLocal(incoming({ platform: "wechat", conversationId: "wxid_self", senderIsBot: true }));
  assert.deepEqual(decisions, [{ action: "drop", status: "skipped_bot", routeId: null }]);
});

test("没有命中任何路由 → skipped_no_route", () => {
  const decisions = decideLocal(incoming({ platform: "wechat", conversationId: "wxid_someone_else" }));
  assert.deepEqual(decisions, [{ action: "drop", status: "skipped_no_route", routeId: null }]);
});

test("kind=image → notice / unsupported-kind（显式回执，不静默丢弃，也不转发媒体）", () => {
  const decisions = decideLocal(
    incoming({ platform: "wechat", conversationId: "wxid_self", kind: "image", text: null }),
  );

  assert.equal(decisions.length, 1);
  const decision = decisions[0];
  assert.ok(decision, "媒体消息应当产生一条策略决策");
  if (decision.action !== "notice") {
    assert.fail(`期望媒体消息走 notice 分支（显式回执），实际 action=${decision.action}`);
  }
  assert.equal(decision.reason, "unsupported-kind");
  assert.equal(decision.status, "skipped_unsupported_kind");
  assert.equal(decision.route.id, "wx-private-to-qq");
  assert.deepEqual(decision.missing, [], "媒体类型与同意机制无关，missing 必须为空");
});

test("出境边 + crossBorderOpen=false → blocked_cross_border（前置检查已被绕过时的运行期兜底）", () => {
  const crossBorderRoutes = [
    route({
      id: "wx-private-to-tg",
      group: "self-wx-tg",
      from: endpoint("wechat", "wxid_self"),
      to: [target("telegram", "123456789")],
    }),
  ];
  const config = makeConfig(crossBorderRoutes);
  const matrix = matrixOf(config);

  const closed = decideAll(
    incoming({ platform: "wechat", conversationId: "wxid_self" }),
    matrix,
    policyContext(config, { crossBorderOpen: false }),
  );
  assert.deepEqual(closed, [{ action: "drop", status: "blocked_cross_border", routeId: "wx-private-to-tg" }]);

  // 反向对照：闸门打开后同一策略链才允许放行（证明拦截来自闸门而不是其它规则）
  const open = decideAll(
    incoming({ platform: "wechat", conversationId: "wxid_self" }),
    matrix,
    policyContext(config, { crossBorderOpen: true }),
  );
  assert.equal(open.length, 1);
  assert.equal(open[0]?.action, "forward");
});

test("媒体消息在策略层就被拦下：Forwarder 不得向目标会话发送任何内容", async () => {
  const config = makeConfig(localRoutes);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({ config, gateway: gateway.client, matrix: matrixOf(config) });

  const statuses = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_self", kind: "file", text: null }),
  );

  assert.deepEqual(statuses, ["skipped_unsupported_kind"]);
  assert.ok(
    !gateway.sent.some((request) => request.platform === "qq"),
    "合规要求：不支持的类型绝不能转发到目标平台（只允许向源会话发回执）",
  );
});
