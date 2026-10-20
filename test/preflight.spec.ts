/**
 * 合规前置检查（test/preflight.spec.ts）—— 本项目最重要的一组测试。
 *
 * 这些断言对应的是"进程必须拒绝启动"的硬约束：
 * 任何一条不成立，都意味着项目可能带着违法配置运行起来。
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../src/config/load";
import { RISK_NOTICE_VERSION } from "../src/config/schema";
import { runPreflight } from "../src/compliance/preflight";
import {
  hasViolation,
  loadFromRaw,
  preflightFromRaw,
  PROJECT_ROOT,
  rawConfig,
  receiverNotice,
  route,
  target,
  endpoint,
  tempDir,
  TEST_ENV,
  violationCodes,
} from "./fixtures/harness";

function describeViolations(violations: { code: string; message: string }[]): string {
  return violations.map((violation) => `${violation.code}: ${violation.message}`).join("\n");
}

/** 断言报告里存在指定违规码，并在失败信息里列出全部违规（便于定位）。 */
function assertViolation(
  report: { violations: { code: string; message: string; hint: string }[]; ok: boolean },
  code: string,
): void {
  assert.equal(
    report.ok,
    false,
    `期望前置检查失败（${code}），但报告 ok=true。合规要求：该配置必须拒绝启动。`,
  );
  assert.ok(
    hasViolation(report, code),
    `期望出现违规码 ${code}，实际违规：\n${describeViolations(report.violations)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 基线：默认示例必须开箱可用
// ─────────────────────────────────────────────────────────────────────────────

test("默认示例配置 config/config.example.yaml 必须通过全部合规前置检查", () => {
  const configPath = join(PROJECT_ROOT, "config", "config.example.yaml");
  const dataDir = tempDir("example-data");
  const config = loadConfig({ configPath, env: TEST_ENV, dataDir });
  const report = runPreflight({ config, env: TEST_ENV });

  assert.equal(
    report.ok,
    true,
    `默认交付配置必须"最保守可用"并开箱通过前置检查，否则用户会绕过检查。实际违规：\n${describeViolations(report.violations)}`,
  );
  assert.ok(report.matrix, "前置检查通过时必须编译出路由矩阵");
  assert.equal(
    report.matrix?.stats.crossBorderEdges,
    0,
    "默认配置不得包含任何 Telegram 出境边（合规要求：出境路由默认关闭）",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 数据出境闸门（PIPL 第 38/39 条）
// ─────────────────────────────────────────────────────────────────────────────

test("存在 Telegram 目标路由但出境闸门未开 → CROSS_BORDER_GATE_CLOSED（拒绝启动）", () => {
  const raw = rawConfig([
    route({
      id: "wx-to-tg",
      from: endpoint("wechat", "wxid_self"),
      to: [target("telegram", "123456789")],
    }),
  ]);
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "CROSS_BORDER_GATE_CLOSED");
});

test("出境闸门 enabled=true 但 operator/acknowledgedAt/selfMessagesOnlyConfirmed 缺失 → CROSS_BORDER_ACK_INCOMPLETE", () => {
  const raw = rawConfig(
    [
      route({
        id: "wx-to-tg",
        from: endpoint("wechat", "wxid_self"),
        to: [target("telegram", "123456789")],
      }),
    ],
    { compliance: { telegramCrossBorder: { enabled: true } } },
  );
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "CROSS_BORDER_ACK_INCOMPLETE");

  const message = report.violations.find((violation) => violation.code === "CROSS_BORDER_ACK_INCOMPLETE")!.message;
  for (const required of ["operator", "acknowledgedAt", "selfMessagesOnlyConfirmed"]) {
    assert.ok(
      message.includes(required),
      `四件套缺失说明必须明确指出 ${required}（合规要求：缺一不可，不能只报"配置错误"）。实际：${message}`,
    );
  }
});

test("出境四件套齐备时，走私内容 + Telegram 目标可以通过前置检查（闸门确实会打开）", () => {
  const raw = rawConfig(
    [
      route({
        id: "wx-to-tg",
        from: endpoint("wechat", "wxid_self"),
        to: [target("telegram", "123456789")],
      }),
    ],
    {
      compliance: {
        telegramCrossBorder: {
          enabled: true,
          operator: "tester",
          acknowledgedAt: "2026-10-18T00:00:00.000Z",
          selfMessagesOnlyConfirmed: true,
          riskNoticeVersion: RISK_NOTICE_VERSION,
        },
      },
    },
  );
  const { report } = preflightFromRaw(raw);
  assert.equal(
    report.ok,
    true,
    `四件套齐备且仅转发本人消息时应当放行。实际违规：\n${describeViolations(report.violations)}`,
  );
  assert.equal(report.matrix?.stats.crossBorderEdges, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 群聊硬门（本项目整体不支持群聊）
// ─────────────────────────────────────────────────────────────────────────────

test("微信源会话 chatType=group → WECHAT_GROUP_SOURCE_FORBIDDEN（不可配置绕过）", () => {
  const raw = rawConfig([
    route({
      id: "wx-group-source",
      from: endpoint("wechat", "wxid_group", "group"),
      to: [target("qq", "10001")],
    }),
  ]);
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "WECHAT_GROUP_SOURCE_FORBIDDEN");
});

test("微信目标会话 chatType=group → WECHAT_GROUP_TARGET_FORBIDDEN", () => {
  const raw = rawConfig([
    route({
      id: "wx-group-target",
      from: endpoint("wechat", "wxid_self"),
      to: [target("wechat", "wxid_group", "group")],
    }),
  ]);
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "WECHAT_GROUP_TARGET_FORBIDDEN");
});

test("非微信平台的群聊源/目标同样拒绝 → GROUP_CHAT_UNSUPPORTED（PIPL 第 23 条：群内无法逐一取得同意）", () => {
  const raw = rawConfig([
    route({
      id: "qq-group-source",
      from: endpoint("qq", "12345", "group"),
      to: [target("wechat", "wxid_self")],
    }),
    route({
      id: "qq-group-target",
      from: endpoint("wechat", "wxid_self"),
      to: [target("qq", "12345", "group")],
    }),
  ]);
  const { report } = preflightFromRaw(raw);

  assert.equal(report.ok, false, "任何平台的群聊路由都必须拒绝启动");
  const codes = violationCodes(report);
  assert.ok(
    codes.filter((code) => code === "GROUP_CHAT_UNSUPPORTED").length >= 2,
    `期望 QQ 群聊源与 QQ 群聊目标各报一次 GROUP_CHAT_UNSUPPORTED。实际：${codes.join(", ")}`,
  );
  assert.ok(
    !codes.some((code) => code.startsWith("WECHAT_GROUP_")),
    `非微信平台群聊不应误报成微信专用错误码。实际：${codes.join(", ")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 他人内容：告知—同意（PIPL 第 23 条）
// ─────────────────────────────────────────────────────────────────────────────

test("contentOwner=third-party 但同意机制关闭 → THIRD_PARTY_CONSENT_DISABLED", () => {
  const raw = rawConfig([
    route({
      id: "third-party-route",
      contentOwner: "third-party",
      from: endpoint("wechat", "wxid_colleague"),
      to: [target("qq", "10002", "private", receiverNotice())],
    }),
  ]);
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "THIRD_PARTY_CONSENT_DISABLED");
});

test("third-party 路由的目标缺少 receiver 告知要素 → THIRD_PARTY_NOTICE_MISSING", () => {
  const raw = rawConfig(
    [
      route({
        id: "third-party-route",
        contentOwner: "third-party",
        from: endpoint("wechat", "wxid_colleague"),
        to: [target("qq", "10002")],
      }),
    ],
    { compliance: { thirdPartyConsent: { enabled: true } } },
  );
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "THIRD_PARTY_NOTICE_MISSING");
});

test("third-party + Telegram 目标 + allowCrossBorder=false → THIRD_PARTY_CROSS_BORDER_FORBIDDEN", () => {
  const raw = rawConfig(
    [
      route({
        id: "third-party-to-tg",
        contentOwner: "third-party",
        from: endpoint("wechat", "wxid_colleague"),
        to: [target("telegram", "123456789", "private", receiverNotice())],
      }),
    ],
    {
      compliance: {
        // 出境闸门本身已打开，用来隔离出"他人内容出境"这单独一条违规
        telegramCrossBorder: {
          enabled: true,
          operator: "tester",
          acknowledgedAt: "2026-10-18T00:00:00.000Z",
          selfMessagesOnlyConfirmed: true,
          riskNoticeVersion: RISK_NOTICE_VERSION,
        },
        thirdPartyConsent: { enabled: true, allowCrossBorder: false },
      },
    },
  );
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "THIRD_PARTY_CROSS_BORDER_FORBIDDEN");
});

test("third-party 出境在 allowCrossBorder=true 且闸门打开时才允许启动", () => {
  const raw = rawConfig(
    [
      route({
        id: "third-party-to-tg",
        contentOwner: "third-party",
        from: endpoint("wechat", "wxid_colleague"),
        to: [target("telegram", "123456789", "private", receiverNotice())],
      }),
    ],
    {
      compliance: {
        telegramCrossBorder: {
          enabled: true,
          operator: "tester",
          acknowledgedAt: "2026-10-18T00:00:00.000Z",
          selfMessagesOnlyConfirmed: true,
          riskNoticeVersion: RISK_NOTICE_VERSION,
        },
        thirdPartyConsent: { enabled: true, allowCrossBorder: true },
      },
    },
  );
  const { report } = preflightFromRaw(raw);
  assert.equal(
    report.ok,
    true,
    `全部显式豁免齐备时应放行（这是使用者自担责任后的最宽松边界）。实际违规：\n${describeViolations(report.violations)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 禁止直连平台 / 令牌 / 目录
// ─────────────────────────────────────────────────────────────────────────────

test("gateway.baseUrl 指向微信 iLink 官方域名 → DIRECT_PLATFORM_ENDPOINT", () => {
  const raw = rawConfig(
    [
      route({
        id: "wx-to-qq",
        from: endpoint("wechat", "wxid_self"),
        to: [target("qq", "10001")],
      }),
    ],
    { gateway: { baseUrl: "https://ilinkai.weixin.qq.com" } },
  );
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "DIRECT_PLATFORM_ENDPOINT");
});

test("网关令牌环境变量未设置 → GATEWAY_TOKEN_MISSING（令牌只允许来自环境变量）", () => {
  const raw = rawConfig([
    route({
      id: "wx-to-qq",
      from: endpoint("wechat", "wxid_self"),
      to: [target("qq", "10001")],
    }),
  ]);
  const { report } = preflightFromRaw(raw, {});
  assertViolation(report, "GATEWAY_TOKEN_MISSING");
});

// ─────────────────────────────────────────────────────────────────────────────
// 配置入口的防线：危险键 + 未知字段
// ─────────────────────────────────────────────────────────────────────────────

test("配置出现 wechat.cookie 等平台登录态 → loadConfig 抛 ConfigError（危险键扫描先于 schema）", () => {
  const raw = rawConfig(
    [
      route({
        id: "wx-to-qq",
        from: endpoint("wechat", "wxid_self"),
        to: [target("qq", "10001")],
      }),
    ],
    { extra: { wechat: { cookie: "sessionid=deadbeef" } } },
  );

  let caught: unknown;
  try {
    loadFromRaw(raw);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ConfigError,
    "合规要求：配置文件出现平台 Cookie/登录态时必须直接拒绝，不允许静默忽略",
  );
  assert.ok(
    (caught as ConfigError).details.some((detail) => detail.includes("cookie")),
    `错误详情必须指出命中的键（wechat.cookie）。实际：${(caught as ConfigError).details.join("; ")}`,
  );
});

test("配置出现 bot_token（网关侧微信凭证）→ loadConfig 抛 ConfigError", () => {
  const raw = rawConfig(
    [
      route({
        id: "wx-to-qq",
        from: endpoint("wechat", "wxid_self"),
        to: [target("qq", "10001")],
      }),
    ],
    { gateway: { bot_token: "ilink-secret" } },
  );

  let caught: unknown;
  try {
    loadFromRaw(raw);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ConfigError, "合规要求：bot_token 属于网关侧，禁止出现在本服务配置中");
  assert.ok(
    (caught as ConfigError).details.some((detail) => detail.includes("bot_token")),
    `错误详情必须指出命中的键（gateway.bot_token）。实际：${(caught as ConfigError).details.join("; ")}`,
  );
});

test("未知配置字段 routes[0].foo → ConfigError（strict schema，不做尽力而为的猜测）", () => {
  const raw = rawConfig([
    route({
      id: "wx-to-qq",
      from: endpoint("wechat", "wxid_self"),
      to: [target("qq", "10001")],
    }),
  ]);
  const routes = raw["routes"] as Array<Record<string, unknown>>;
  assert.ok(routes[0], "测试构造错误：routes 为空");
  routes[0]!["foo"] = "bar";

  let caught: unknown;
  try {
    loadFromRaw(raw);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ConfigError,
    "合规要求：未知字段必须报错而不是被忽略（否则可被用作隐藏的绕过开关）",
  );
  assert.ok(
    (caught as ConfigError).details.join("; ").includes("foo"),
    `错误详情必须指出未知字段名。实际：${(caught as ConfigError).details.join("; ")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 回环防护：存在环时不允许关闭
// ─────────────────────────────────────────────────────────────────────────────

test("loopGuard.enabled=false 且存在双向路由（有环）→ LOOP_GUARD_REQUIRED", () => {
  const raw = rawConfig(
    [
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
    ],
    { compliance: { loopGuard: { enabled: false } } },
  );
  const { report } = preflightFromRaw(raw);
  assertViolation(report, "LOOP_GUARD_REQUIRED");
});
