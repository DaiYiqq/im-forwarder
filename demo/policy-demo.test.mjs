/**
 * 在线 Demo 的自检（Node 直接运行，无需浏览器）：
 *   node demo/policy-demo.test.mjs
 *
 * 覆盖：
 *  1. 策略镜像行为（群聊/媒体/自身/bot/无路由/出境/同意/回环/CQ 注入/日志白名单）；
 *  2. 路由矩阵编译（自环、重复 id/边、group 冲突、环、跨 group 环、出境闸门、third-party）；
 *  3. 中英双语完整性（index.html 用到的每个 key 在 zh/en 都存在，且两语言 key 集合一致）；
 *  4. 截图/动图资产存在且文件头合法。
 */

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await import("./policy-demo.js");
await import("./i18n.js");
const P = globalThis.PolicyDemo;
const I18N = globalThis.DEMO_I18N;
assert.ok(P, "PolicyDemo 未挂载到 globalThis");
assert.ok(I18N, "DEMO_I18N 未挂载到 globalThis");

const byId = (id) => P.scenarios.find((scenario) => scenario.id === id);
const baseGate = { enabled: false, operator: "", acknowledgedAt: "", selfMessagesOnlyConfirmed: false, riskNoticeVersion: "" };
const openGate = {
  enabled: true,
  operator: "demo",
  acknowledgedAt: "2026-10-21T09:00:00+08:00",
  selfMessagesOnlyConfirmed: true,
  riskNoticeVersion: P.RISK_NOTICE_VERSION,
};

// ── 1. 策略镜像 ─────────────────────────────────────────────────────────
const normal = P.decide(byId("normal"));
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
assert.equal(P.decide(byId("group")).status, "skipped_group_forbidden");
assert.ok(P.checkRouteShape(P.routes.wxGroup).some((issue) => issue.code === "WECHAT_GROUP_SOURCE_FORBIDDEN"));
assert.ok(
  P.checkRouteShape({
    from: { platform: "wechat", conversationId: "a", chatType: "private" },
    to: [{ platform: "qq", conversationId: "1", chatType: "group" }],
  }).some((issue) => issue.code === "GROUP_CHAT_UNSUPPORTED"),
);
const media = P.decide(byId("media"));
assert.equal(media.status, "skipped_unsupported_kind");
assert.ok(media.notice && media.notice.zh.includes("不支持") && media.notice.en.includes("cannot"));
assert.equal(P.decide(byId("self")).status, "skipped_self");
assert.equal(P.decide(byId("bot")).status, "skipped_bot");
assert.equal(P.decide(byId("noroute")).status, "skipped_no_route");
assert.equal(P.decide(byId("tg")).status, "blocked_cross_border");
assert.equal(P.decide({ ...byId("tg"), gate: openGate }).status, "forwarded");
assert.equal(P.evaluateCrossBorderGate(openGate).open, true);
assert.equal(P.evaluateCrossBorderGate({ ...openGate, selfMessagesOnlyConfirmed: false }).open, false);
assert.equal(P.decide(byId("thirdparty")).status, "blocked_consent_pending");
assert.equal(P.decide({ ...byId("thirdparty"), consentGranted: true }).status, "forwarded");
assert.equal(P.decide(byId("loop")).status, "skipped_loop_suspected");
const injected = P.decide(byId("cqinject"));
assert.equal(injected.status, "forwarded");
const sent = injected.sentPayload.segments[0].text;
assert.ok(!sent.includes("[CQ:"), "转义后不得残留裸 [CQ:");
assert.ok(sent.includes("&#91;CQ:at,qq=all&#93;"));

// ── 2. 矩阵编译 ─────────────────────────────────────────────────────────
const demoRoutes = P.defaultEditorRoutes();
const okMatrix = P.compileMatrix(demoRoutes, { gate: baseGate, consentEnabled: false });
assert.equal(okMatrix.ok, true);
assert.equal(okMatrix.exitCode, 0);
assert.equal(okMatrix.cycles.length, 1, "默认双向链路应构成 1 个环");
assert.equal(okMatrix.stats.routes, 2);
assert.equal(okMatrix.stats.edges, 2);

const tgMatrix = P.compileMatrix([...demoRoutes, P.routes.wxToTelegram], { gate: baseGate });
assert.equal(tgMatrix.exitCode, 78);
assert.ok(tgMatrix.issues.some((issue) => issue.code === "CROSS_BORDER_GATE_CLOSED"));

const openMatrix = P.compileMatrix([...demoRoutes, P.routes.wxToTelegram], { gate: openGate });
assert.equal(openMatrix.ok, true, "五要素齐备后出境路由可以加载");

const groupMatrix = P.compileMatrix([P.routes.wxGroup], { gate: baseGate });
assert.ok(groupMatrix.issues.some((issue) => issue.code === "WECHAT_GROUP_SOURCE_FORBIDDEN"));

const thirdPartyMatrix = P.compileMatrix([P.routes.thirdParty], { gate: baseGate, consentEnabled: false });
assert.ok(thirdPartyMatrix.issues.some((issue) => issue.code === "THIRD_PARTY_CONSENT_DISABLED"));

const selfLoop = { id: "self-loop", group: "g", contentOwner: "self", from: { platform: "qq", conversationId: "1", chatType: "private" }, to: [{ platform: "qq", conversationId: "1", chatType: "private" }] };
assert.ok(P.compileMatrix([selfLoop], { gate: baseGate }).issues.some((issue) => issue.code === "ROUTE_SELF_LOOP"));

const dupId = P.compileMatrix([demoRoutes[0], { ...demoRoutes[1], id: demoRoutes[0].id }], { gate: baseGate });
assert.ok(dupId.issues.some((issue) => issue.code === "DUPLICATE_ROUTE_ID"));

const crossGroup = P.compileMatrix(
  [
    { id: "a", group: "g1", contentOwner: "self", from: { platform: "wechat", conversationId: "w", chatType: "private" }, to: [{ platform: "qq", conversationId: "q", chatType: "private" }] },
    { id: "b", group: "g2", contentOwner: "self", from: { platform: "qq", conversationId: "q", chatType: "private" }, to: [{ platform: "wechat", conversationId: "w", chatType: "private" }] },
  ],
  { gate: baseGate },
);
assert.ok(crossGroup.issues.some((issue) => issue.code === "CYCLE_ACROSS_GROUPS"));

const noLoopGuard = P.compileMatrix(demoRoutes, { gate: baseGate, loopGuardEnabled: false });
assert.ok(noLoopGuard.issues.some((issue) => issue.code === "LOOP_GUARD_REQUIRED"));

// 中文/英文问题文案都必须存在
for (const issue of [...tgMatrix.issues, ...groupMatrix.issues]) {
  assert.ok(issue.message.zh && issue.message.en, `issue ${issue.code} 缺少双语文案`);
}

// ── 3. i18n 完整性 ──────────────────────────────────────────────────────
const html = readFileSync(path.join(here, "index.html"), "utf8");
const usedKeys = new Set([...html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map((match) => match[1]));
const zhKeys = new Set(Object.keys(I18N.zh));
const enKeys = new Set(Object.keys(I18N.en));
assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), "zh/en 的 key 集合必须完全一致");
for (const key of usedKeys) {
  assert.ok(zhKeys.has(key), `index.html 使用了 key "${key}"，但 zh 字典缺少`);
  assert.ok(enKeys.has(key), `index.html 使用了 key "${key}"，但 en 字典缺少`);
}
for (const scenario of P.scenarios) {
  for (const part of [scenario.label, scenario.desc]) {
    assert.ok(part && part.zh && part.en, `scenario ${scenario.id} 缺少双语文案`);
  }
}
// 动态状态文案（status.*）必须覆盖 decide 可能返回的全部状态
const statuses = new Set(P.scenarios.map((scenario) => P.decide(scenario).status));
for (const status of statuses) {
  assert.ok(zhKeys.has("status." + status), `缺少状态文案 zh: status.${status}`);
  assert.ok(enKeys.has("status." + status), `缺少状态文案 en: status.${status}`);
}

// ── 4. 截图/动图资产 ────────────────────────────────────────────────────
for (const name of ["desktop-status.png", "desktop-config.png", "desktop-logs.png", "desktop-about.png"]) {
  const file = path.join(here, "images", name);
  const stat = statSync(file);
  assert.ok(stat.size > 20 * 1024, `${name} 过小（可能截图为空）：${stat.size}`);
  const head = readFileSync(file).subarray(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name} 不是合法 PNG`);
}
const gif = readFileSync(path.join(here, "images", "desktop-demo.gif"));
assert.ok(gif.length > 50 * 1024, `GIF 过小：${gif.length} bytes`);
assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a");

console.log(
  `[demo] self-test passed: ${P.scenarios.length} scenarios, ${demoRoutes.length} default routes, ` +
    `${zhKeys.size} i18n keys, screenshots + gif OK`,
);
