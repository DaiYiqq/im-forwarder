/**
 * 群聊硬门（test/private-only.spec.ts）。
 *
 * 这是"运行期兜底"而非配置校验：即使路由矩阵里只有私聊节点，
 * 只要网关推来一条群聊消息，策略链也必须在**路由解析之前**把它丢掉。
 * 这样即使配置被绕过/被篡改，群聊消息也不会被转发。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideAll } from "../src/routing/policy";
import { incoming, makeConfig, makeForwarder, fakeGateway, route, target, endpoint, policyContext, matrixOf } from "./fixtures/harness";

const privateRoutes = [
  route({
    id: "wx-private-to-qq",
    group: "self-wx-qq",
    from: endpoint("wechat", "wxid_self"),
    to: [target("qq", "10001")],
  }),
];

test("矩阵只含私聊路由时，直接喂一条微信群聊消息 → skipped_group_forbidden", () => {
  const config = makeConfig(privateRoutes);
  const matrix = matrixOf(config);

  const decisions = decideAll(
    incoming({
      platform: "wechat",
      conversationId: "wxid_self",
      // 关键：会话键与私聊路由完全相同，只有 chatType 是 group
      chatType: "group",
      text: "群聊里的消息",
    }),
    matrix,
    policyContext(config),
  );

  assert.equal(decisions.length, 1, "群聊消息必须只产生一条丢弃决策");
  assert.deepEqual(
    decisions[0],
    { action: "drop", status: "skipped_group_forbidden", routeId: null },
    "合规要求：微信群聊消息必须被丢弃；chatType 是硬门，不受路由配置影响",
  );
});

test("非微信平台的群聊消息同样被运行期硬门丢弃（本项目整体不支持群聊）", () => {
  const config = makeConfig([
    route({
      id: "qq-private-to-wx",
      group: "self-qq-wx",
      from: endpoint("qq", "10001"),
      to: [target("wechat", "wxid_self")],
    }),
  ]);
  const matrix = matrixOf(config);

  const decisions = decideAll(
    incoming({
      platform: "qq",
      conversationId: "10001",
      chatType: "group",
      text: "QQ 群消息",
    }),
    matrix,
    policyContext(config),
  );

  assert.deepEqual(decisions, [{ action: "drop", status: "skipped_group_forbidden", routeId: null }]);
});

test("Forwarder 收到群聊消息时不得向任何会话发送任何内容", async () => {
  const config = makeConfig(privateRoutes);
  const gateway = fakeGateway();
  const forwarder = makeForwarder({ config, gateway: gateway.client, matrix: matrixOf(config) });

  const statuses = await forwarder.handle(
    incoming({
      platform: "wechat",
      conversationId: "wxid_self",
      chatType: "group",
      text: "这条群聊消息绝不能出现在 QQ 会话里",
    }),
  );

  assert.deepEqual(statuses, ["skipped_group_forbidden"]);
  assert.equal(gateway.sent.length, 0, "群聊消息既不能转发，也不能触发任何回执发送");
});
