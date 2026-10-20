/**
 * 日志脱敏验收（test/redaction.spec.ts）—— 这是"日志绝不出现正文"的验收重点。
 *
 * 三道断言：
 *  1. 用 `Forwarder` 真实跑通一条带 canary 的消息，扫描**所有**日志行：
 *     不得出现 canary，也不得出现正文任意 8 字以上子串；
 *  2. 每行日志的字段集合必须 ⊆ LOG_FIELD_WHITELIST ∪ {ts, level}；
 *  3. 即使有人把正文塞进"合法字段"（例如 content / 超长 errorCode），
 *     运行层白名单与超长替换也要把它丢掉（不保留前缀）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LOG_FIELD_WHITELIST, type LogFields } from "../src/observability/logger";
import {
  endpoint,
  fakeGateway,
  incoming,
  makeConfig,
  makeForwarder,
  matrixOf,
  memoryLogger,
  route,
  target,
} from "./fixtures/harness";

const CANARY = "SECRET-CANARY-9f3a消息正文";

const routes = [
  route({
    id: "wx-private-to-qq",
    group: "self-wx-qq",
    from: endpoint("wechat", "wxid_self"),
    to: [target("qq", "10001")],
  }),
];

const ALLOWED_LOG_KEYS = new Set<string>([...LOG_FIELD_WHITELIST, "ts", "level"]);

function assertLineKeysWhitelisted(line: string): void {
  const record = JSON.parse(line) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    assert.ok(
      ALLOWED_LOG_KEYS.has(key),
      `日志字段 ${key} 不在白名单内（日志只允许白名单字段，避免正文/凭据被夹带）。日志行：${line}`,
    );
  }
}

test("真实转发带 canary 的消息：所有日志行都不含正文（含任意 8 字以上子串）且字段全在白名单内", async () => {
  const config = makeConfig(routes);
  const gateway = fakeGateway();
  const { logger, lines } = memoryLogger("debug");
  const forwarder = makeForwarder({
    config,
    gateway: gateway.client,
    matrix: matrixOf(config),
    logger,
  });

  const statuses = await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_self", messageId: "redact-1", text: CANARY }),
  );
  assert.deepEqual(statuses, ["forwarded"], "先确保这条消息真的被转发了，日志断言才有意义");
  assert.equal(gateway.sent.length, 1);
  assert.ok(lines.length > 0, "debug 级别下必须有日志输出，否则本测试没有覆盖到任何日志路径");

  for (const line of lines) {
    assert.ok(!line.includes("SECRET-CANARY-9f3a"), `日志出现了正文 canary（合规红线）：${line}`);

    // 任意 8 字以上连续子串都不得出现（防止只泄漏片段）
    for (let index = 0; index + 8 <= CANARY.length; index += 1) {
      const fragment = CANARY.slice(index, index + 8);
      assert.ok(
        !line.includes(fragment),
        `日志出现了正文的 8 字以上子串「${fragment}」（合规要求：日志绝不出现消息正文）：${line}`,
      );
    }

    assertLineKeysWhitelisted(line);
  }
});

test("把正文塞进非白名单字段（content）→ 运行层直接丢弃该字段", () => {
  const { logger, lines } = memoryLogger("debug");

  logger.info({ event: "x", content: "canary-content-SHOULD-NOT-APPEAR" } as unknown as LogFields);

  assert.equal(lines.length, 1);
  const line = lines[0] ?? "";
  assert.ok(!line.includes("canary-content-SHOULD-NOT-APPEAR"), `非白名单字段必须被丢弃：${line}`);
  const record = JSON.parse(line) as Record<string, unknown>;
  assert.equal(record["content"], undefined, "content 不是白名单字段，不得出现在日志里");
  assert.deepEqual(Object.keys(record).sort(), ["event", "level", "ts"]);
});

test("超长字符串字段替换为 [omitted:N]，绝不保留前缀（前缀仍可能泄漏正文片段）", () => {
  const { logger, lines } = memoryLogger("debug");

  const long = "L".repeat(150);
  logger.info({ event: "x", errorCode: long });
  const overlongLine = lines[lines.length - 1] ?? "";
  const overlongRecord = JSON.parse(overlongLine) as Record<string, unknown>;
  assert.equal(overlongRecord["errorCode"], "[omitted:150]", `超长字段必须整体替换。日志行：${overlongLine}`);
  assert.ok(!overlongLine.includes("LLLLLLLLLL"), `不得保留前 N 个字符。日志行：${overlongLine}`);

  // 边界：120 字符仍保留（阈值语义稳定，不会悄悄把所有字段都吃掉）
  const atLimit = "M".repeat(120);
  logger.info({ event: "x", errorCode: atLimit });
  const atLimitRecord = JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
  assert.equal(atLimitRecord["errorCode"], atLimit);

  // 控制字符/换行被清理，避免日志注入与多行伪造
  logger.info({ event: "x", errorCode: "bad\ncode\u0000end" });
  const controlRecord = JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
  assert.equal(controlRecord["errorCode"], "bad code end");
});

test("Forwarder 的每条日志都只使用白名单字段（对默认 info 级别再验一遍）", async () => {
  const config = makeConfig(routes);
  const gateway = fakeGateway();
  const { logger, lines } = memoryLogger("debug");
  const forwarder = makeForwarder({ config, gateway: gateway.client, matrix: matrixOf(config), logger });

  await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_self", messageId: "redact-2", text: "普通正文" }),
  );
  await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_self", messageId: "redact-3", kind: "image", text: null }),
  );
  await forwarder.handle(
    incoming({ platform: "wechat", conversationId: "wxid_self", messageId: "redact-4", senderIsSelf: true }),
  );

  assert.ok(lines.length >= 3);
  for (const line of lines) {
    assertLineKeysWhitelisted(line);
    assert.ok(!line.includes("普通正文"), "正文不得出现在日志中");
  }
});
