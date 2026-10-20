/**
 * 路由矩阵编译（test/matrix.spec.ts）。
 *
 * 关注点：
 *  - 三平台任意定向边都能建图并建立 bySource 索引（运行时命中的唯一入口）；
 *  - 结构性冲突（重复 id / 重复边 / 自环）必须编译期失败，不允许"自动取舍"；
 *  - 环本身允许（默认链路就是双向的），但跨 group 的环必须失败：
 *    那意味着两条独立链路互相喂消息，内容指纹防护会失效。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Platform } from "../src/types";
import { compileMatrix, RouteMatrixError, type CompiledMatrix } from "../src/routing/matrix";
import { endpoint, route, target } from "./fixtures/harness";

function assertMatrixError(routes: ReturnType<typeof route>[], code: string): void {
  let caught: unknown;
  try {
    compileMatrix(routes);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof RouteMatrixError,
    `期望 compileMatrix 抛 RouteMatrixError（${code}），实际：${String(caught)}`,
  );
  assert.ok(
    caught.violations.some((violation) => violation.startsWith(code)),
    `期望违规 ${code}，实际违规：\n${caught.violations.join("\n")}`,
  );
}

const ORDERED_PLATFORM_PAIRS: ReadonlyArray<readonly [Platform, Platform]> = [
  ["wechat", "qq"],
  ["qq", "wechat"],
  ["qq", "telegram"],
  ["telegram", "qq"],
  ["wechat", "telegram"],
  ["telegram", "wechat"],
];

test("任意两平台的定向边都能编译并建立 bySource 索引", () => {
  for (const [fromPlatform, toPlatform] of ORDERED_PLATFORM_PAIRS) {
    const compiled: CompiledMatrix = compileMatrix([
      route({
        id: `${fromPlatform}-to-${toPlatform}`,
        from: endpoint(fromPlatform, `${fromPlatform}-conv`),
        to: [target(toPlatform, `${toPlatform}-conv`)],
      }),
    ]);

    const sourceKey = `${fromPlatform}:${fromPlatform}-conv:private`;
    const routes = compiled.bySource.get(sourceKey);
    assert.ok(
      routes && routes.length === 1,
      `bySource 必须能按 ${sourceKey} 命中路由；实际键：${[...compiled.bySource.keys()].join(", ")}`,
    );
    assert.equal(routes[0]?.id, `${fromPlatform}-to-${toPlatform}`);
    assert.equal(compiled.stats.edges, 1);
    assert.equal(compiled.stats.groups, 1);
    assert.equal(compiled.cycles.length, 0);
  }
});

test("重复的 route id → 编译失败（DUPLICATE_ROUTE_ID）", () => {
  assertMatrixError(
    [
      route({
        id: "dup",
        from: endpoint("wechat", "wxid_a"),
        to: [target("qq", "10001")],
      }),
      route({
        id: "dup",
        from: endpoint("qq", "10002"),
        to: [target("wechat", "wxid_b")],
      }),
    ],
    "DUPLICATE_ROUTE_ID",
  );
});

test("重复的路由边 → 编译失败（DUPLICATE_EDGE）", () => {
  assertMatrixError(
    [
      route({
        id: "edge-a",
        from: endpoint("wechat", "wxid_a"),
        to: [target("qq", "10001")],
      }),
      route({
        id: "edge-b",
        from: endpoint("wechat", "wxid_a"),
        to: [target("qq", "10001")],
      }),
    ],
    "DUPLICATE_EDGE",
  );
});

test("自环（from == to）→ 编译失败（ROUTE_SELF_LOOP）", () => {
  const endpointRef = endpoint("wechat", "wxid_self");
  assertMatrixError(
    [
      route({
        id: "self-loop",
        from: endpointRef,
        to: [target("wechat", "wxid_self")],
      }),
    ],
    "ROUTE_SELF_LOOP",
  );
});

test("双向路由（同 group）→ 允许，且恰好识别出 1 个非跨 group 环", () => {
  const compiled = compileMatrix([
    route({
      id: "wx-to-qq",
      group: "self-wx-qq",
      from: endpoint("wechat", "wxid_self"),
      to: [target("qq", "10001")],
    }),
    route({
      id: "qq-to-wx",
      group: "self-wx-qq",
      from: endpoint("qq", "10001"),
      to: [target("wechat", "wxid_self")],
    }),
  ]);

  assert.equal(compiled.cycles.length, 1, "微信 ↔ QQ 双向链路天然构成一个环");
  assert.equal(compiled.cycles[0]?.crossGroup, false, "同 group 内的环由 loopGuard 兜住，是合法配置");
  assert.equal(compiled.stats.edges, 2);
  assert.equal(compiled.stats.groups, 1);
  // 环节点首尾相同（A → B → A）
  assert.equal(compiled.cycles[0]?.nodes.length, 3);
  assert.equal(compiled.cycles[0]?.nodes[0], compiled.cycles[0]?.nodes[2]);
});

test("两条边跨 group 成环 → 编译失败（CYCLE_ACROSS_GROUPS）", () => {
  assertMatrixError(
    [
      route({
        id: "edge-1",
        group: "group-a",
        from: endpoint("wechat", "wxid_self"),
        to: [target("qq", "10001")],
      }),
      route({
        id: "edge-2",
        group: "group-b",
        from: endpoint("qq", "10001"),
        to: [target("wechat", "wxid_self")],
      }),
    ],
    "CYCLE_ACROSS_GROUPS",
  );
});

test("同一 group 内 contentOwner 冲突 → 编译失败（GROUP_CONTENT_OWNER_CONFLICT）", () => {
  assertMatrixError(
    [
      route({
        id: "self-route",
        group: "shared-group",
        contentOwner: "self",
        from: endpoint("wechat", "wxid_self"),
        to: [target("qq", "10001")],
      }),
      route({
        id: "third-party-route",
        group: "shared-group",
        contentOwner: "third-party",
        from: endpoint("qq", "10002"),
        to: [target("wechat", "wxid_colleague")],
      }),
    ],
    "GROUP_CONTENT_OWNER_CONFLICT",
  );
});
