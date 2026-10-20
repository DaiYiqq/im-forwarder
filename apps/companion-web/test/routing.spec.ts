import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BMODE_ROUTES,
  parseBModeRoutes,
  selectTargets,
  validateBModeRoutes,
} from "../src/experimental/routing.ts";

function validRoute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wx-to-qq",
    group: "self-pair",
    contentOwner: "self",
    from: { platform: "wechat", conversationId: "wx_self", chatType: "private" },
    to: [{ platform: "qq", conversationId: "qq_self", chatType: "private" }],
    ...overrides,
  };
}

test("合法私聊本人微信→QQ 路由通过校验", () => {
  const result = validateBModeRoutes([validRoute()]);
  assert.deepEqual(result.violations, []);
  assert.equal(result.routes.length, 1);
  const route = result.routes[0];
  assert.ok(route);
  assert.equal(route.contentOwner, "self");
  assert.equal(route.from.platform, "wechat");
  assert.equal(route.to[0]?.platform, "qq");
});

test("拒绝群聊路由（from 或 to 任意一侧）", () => {
  const fromGroup = validateBModeRoutes([
    validRoute({ from: { platform: "wechat", conversationId: "wx_self", chatType: "group" } }),
  ]);
  assert.equal(fromGroup.routes.length, 0);
  assert.ok(fromGroup.violations.some((item) => item.includes("群聊")));

  const toGroup = validateBModeRoutes([
    validRoute({ to: [{ platform: "qq", conversationId: "qq_group", chatType: "group" }] }),
  ]);
  assert.equal(toGroup.routes.length, 0);
  assert.ok(toGroup.violations.some((item) => item.includes("群聊")));
});

test("拒绝 Telegram 出境/入境路由（明确提示而非静默丢弃）", () => {
  const toTelegram = validateBModeRoutes([
    validRoute({ to: [{ platform: "telegram", conversationId: "123", chatType: "private" }] }),
  ]);
  assert.equal(toTelegram.routes.length, 0);
  assert.ok(toTelegram.violations.some((item) => item.includes("Telegram")));

  const fromTelegram = validateBModeRoutes([
    validRoute({ from: { platform: "telegram", conversationId: "123", chatType: "private" } }),
  ]);
  assert.equal(fromTelegram.routes.length, 0);
  assert.ok(fromTelegram.violations.some((item) => item.includes("Telegram")));
});

test("拒绝 contentOwner=third-party（不转发他人内容）", () => {
  const result = validateBModeRoutes([validRoute({ contentOwner: "third-party" })]);
  assert.equal(result.routes.length, 0);
  assert.ok(result.violations.some((item) => item.includes("third-party")));
});

test("拒绝 contentOwner 非 self 的其它取值", () => {
  const result = validateBModeRoutes([validRoute({ contentOwner: "someone" })]);
  assert.equal(result.routes.length, 0);
  assert.ok(result.violations.some((item) => item.includes("contentOwner")));
});

test("拒绝同平台路由（仅允许微信 ↔ QQ）", () => {
  const result = validateBModeRoutes([
    validRoute({ to: [{ platform: "wechat", conversationId: "wx_other", chatType: "private" }] }),
  ]);
  assert.equal(result.routes.length, 0);
  assert.ok(result.violations.some((item) => item.includes("平台必须不同")));
});

test("拒绝未知字段（fail-closed，不静默忽略）", () => {
  const result = validateBModeRoutes([validRoute({ media: true })]);
  assert.equal(result.routes.length, 0);
  assert.ok(result.violations.some((item) => item.includes("media")));
});

test("拒绝重复 id、空 to、重复目标", () => {
  const duplicateId = validateBModeRoutes([validRoute(), validRoute({ from: { platform: "qq", conversationId: "qq_self", chatType: "private" }, to: [{ platform: "wechat", conversationId: "wx_self", chatType: "private" }] })]);
  assert.equal(duplicateId.routes.length, 0);
  assert.ok(duplicateId.violations.some((item) => item.includes("id 重复")));

  const emptyTo = validateBModeRoutes([validRoute({ to: [] })]);
  assert.equal(emptyTo.routes.length, 0);
  assert.ok(emptyTo.violations.some((item) => item.includes("to")));

  const duplicateTarget = validateBModeRoutes([
    validRoute({
      to: [
        { platform: "qq", conversationId: "qq_self", chatType: "private" },
        { platform: "qq", conversationId: "qq_self", chatType: "private" },
      ],
    }),
  ]);
  assert.equal(duplicateTarget.routes.length, 0);
  assert.ok(duplicateTarget.violations.some((item) => item.includes("目标端点重复")));
});

test("路由条数上限与空数组", () => {
  const many = Array.from({ length: MAX_BMODE_ROUTES + 1 }, (_, index) =>
    validRoute({
      id: `route_${index}`,
      from: { platform: "wechat", conversationId: `wx_${index}`, chatType: "private" },
      to: [{ platform: "qq", conversationId: `qq_${index}`, chatType: "private" }],
    }),
  );
  const tooMany = validateBModeRoutes(many);
  assert.equal(tooMany.routes.length, 0);
  assert.ok(tooMany.violations.some((item) => item.includes("最多")));

  const empty = validateBModeRoutes([]);
  assert.equal(empty.routes.length, 0);
  assert.ok(empty.violations.length > 0);
});

test("parseBModeRoutes：JSON 语法错误与空输入给出可读提示", () => {
  const badJson = parseBModeRoutes("{ not json");
  assert.equal(badJson.routes.length, 0);
  assert.ok(badJson.violations[0]?.includes("JSON"));

  const blank = parseBModeRoutes("   ");
  assert.equal(blank.routes.length, 0);
  assert.ok(blank.violations[0]?.includes("为空"));
});

test("selectTargets 只做精确匹配且拒绝群聊", () => {
  const result = validateBModeRoutes([validRoute()]);
  const [route] = result.routes;
  assert.ok(route);

  assert.equal(
    selectTargets([route], { platform: "wechat", conversationId: "wx_self", chatType: "private" }).length,
    1,
  );
  assert.equal(
    selectTargets([route], { platform: "wechat", conversationId: "wx_self", chatType: "group" }).length,
    0,
  );
  assert.equal(
    selectTargets([route], { platform: "wechat", conversationId: "wx_other", chatType: "private" }).length,
    0,
  );
  // 前缀/模糊匹配必须命中不到（防止误转发到别的会话）。
  assert.equal(
    selectTargets([route], { platform: "wechat", conversationId: "wx_sel", chatType: "private" }).length,
    0,
  );
});
