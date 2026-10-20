/**
 * 文本转换（test/transform.spec.ts）。
 *
 * 安全重点：CQ 码注入。
 * OneBot/NapCat 用 `[CQ:at,qq=all]` 这类片段表达 @全体成员 / 图片 / 表情。
 * 如果直接把来源文本拼进 QQ 消息，对方发一句话就可能让我们 @ 全员。
 * 因此发往 QQ 的文本必须做 CQ 转义，且转义 + 截断必须"边转义边计数"，
 * 绝不能把 `&#91;` 切成半截实体。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  escapeCqCodes,
  normalizeText,
  PLATFORM_TEXT_LIMITS,
  renderForTarget,
  truncate,
} from "../src/pipeline/transform";

const TRUNCATION_SUFFIX = "…(已截断)";

test("CQ 码注入：发往 QQ 的 [CQ:at,qq=all] 必须被完整转义，不残留裸 [CQ:", () => {
  const rendered = renderForTarget({ text: "[CQ:at,qq=all]", target: { platform: "qq" } });

  assert.ok(!rendered.text.includes("[CQ:"), `不得残留裸 CQ 码（否则可能 @全体成员）。实际：${rendered.text}`);
  assert.ok(rendered.text.includes("&#91;CQ:at,qq=all&#93;"), `实际：${rendered.text}`);
});

test("CQ 转义顺序：先 & 后括号（& → &amp;，[ → &#91;，] → &#93;）", () => {
  assert.equal(escapeCqCodes("a&b"), "a&amp;b");
  assert.equal(escapeCqCodes("[x]"), "&#91;x&#93;");
  assert.equal(
    escapeCqCodes("&[x]"),
    "&amp;&#91;x&#93;",
    "必须先把 & 转义，否则后面生成的实体里的 & 会被二次转义",
  );

  const rendered = renderForTarget({ text: "a&b[c]", target: { platform: "qq" } });
  assert.equal(rendered.text, "a&amp;b&#91;c&#93;");
});

test("超长文本转义后长度不超过平台上限（QQ 4500），且不以半截实体结尾", () => {
  const limit = PLATFORM_TEXT_LIMITS.qq;
  // 2000 个 "[" 转义后是 2000 × 5 = 10000 字符，必然触发截断
  const rendered = renderForTarget({ text: "[".repeat(2000), target: { platform: "qq" } });

  assert.equal(rendered.truncated, true, "2000 个 [ 转义后必然超过 4500，应被截断");
  assert.ok(
    rendered.text.length <= limit,
    `转义 + 截断后的长度必须 ≤ ${limit}，否则网关会拒绝或平台截断出问题。实际：${rendered.text.length}`,
  );
  assert.ok(rendered.text.endsWith(TRUNCATION_SUFFIX), "截断必须带明确后缀，不能静默丢内容");
  assert.ok(!/&#9$/.test(rendered.text), "不得出现 &#9 这种被切一半的实体结尾");

  const body = rendered.text.slice(0, rendered.text.length - TRUNCATION_SUFFIX.length);
  assert.equal(
    /&[^;]*$/.test(body),
    false,
    `截断点前不得留下未闭合的转义实体（例如 &#9 / &amp）。实际结尾：${body.slice(-12)}`,
  );
});

test("普通长文本（非 QQ）按平台上限截断：telegram 4096", () => {
  const rendered = renderForTarget({ text: "a".repeat(5000), target: { platform: "telegram" } });
  assert.equal(rendered.truncated, true);
  assert.ok(rendered.text.length <= PLATFORM_TEXT_LIMITS.telegram);
  assert.ok(rendered.text.endsWith(TRUNCATION_SUFFIX));
});

test("控制字符被清除（保留换行/制表符），换行统一为 \\n", () => {
  assert.equal(normalizeText("a\u0000b\u0001c\u007fd"), "abcd");
  assert.equal(normalizeText("a\r\nb"), "a\nb");
  assert.equal(normalizeText("a\rb"), "a\nb");
  assert.equal(normalizeText("  padded  "), "padded");
  assert.equal(normalizeText("a\tb"), "a\tb", "制表符属于可展示空白，不应被删");
  assert.equal(normalizeText("a\u000bb"), "ab", "垂直制表符属于控制字符，必须清除");
});

test("telegram 目标不转义 CQ 码（CQ 是 QQ 协议特有的）", () => {
  const text = "[CQ:at,qq=all]";
  const rendered = renderForTarget({ text, target: { platform: "telegram" } });
  assert.equal(rendered.text, text, "非 QQ 平台不得做 CQ 转义（会污染原意）");
});

test("truncate 的空值与边界行为：短文本原样返回", () => {
  assert.deepEqual(truncate("short", 100), { text: "short", truncated: false });
  const exact = truncate("x".repeat(100), 100);
  assert.equal(exact.truncated, false);
  assert.equal(exact.text.length, 100);
});
