import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PLATFORM_TEXT_LIMITS,
  escapeCqCodes,
  escapeCqCodesBounded,
  normalizeText,
  renderForTarget,
  truncate,
} from "../src/experimental/transform.ts";

test("CQ 码注入必须被转义（防 @全体成员 等）", () => {
  assert.equal(escapeCqCodes("[CQ:at,qq=all]"), "&#91;CQ:at,qq=all&#93;");
  assert.equal(escapeCqCodes("&[CQ:image,file=x]&"), "&amp;&#91;CQ:image,file=x&#93;&amp;");
  // 顺序正确：& 只转义一次，不会出现 &amp;amp;
  assert.equal(escapeCqCodes("a&b"), "a&amp;b");
});

test("发往 QQ 的文本一律 CQ 转义；发往微信不转义", () => {
  const toQq = renderForTarget({ text: "[CQ:face,id=1]", targetPlatform: "qq" });
  assert.equal(toQq.text, "&#91;CQ:face,id=1&#93;");
  assert.equal(toQq.truncated, false);

  const toWechat = renderForTarget({ text: "[CQ:face,id=1]", targetPlatform: "wechat" });
  assert.equal(toWechat.text, "[CQ:face,id=1]");
});

test("normalizeText：去控制字符、统一换行、去首尾空白", () => {
  assert.equal(normalizeText("a\u0000b\u0007c\r\nd  \n"), "abc\nd");
  assert.equal(normalizeText("   "), "");
  assert.equal(normalizeText("保留\n换行\t制表"), "保留\n换行\t制表");
});

test("truncate：超长时加后缀且长度不超限", () => {
  const result = truncate("x".repeat(100), 20);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 20);
  assert.ok(result.text.endsWith("…(已截断)"));

  const short = truncate("ok", 20);
  assert.deepEqual(short, { text: "ok", truncated: false });
});

test("escapeCqCodesBounded：截断不切断转义实体，且总长受控", () => {
  const input = "[".repeat(2000);
  const result = escapeCqCodesBounded(input, 100);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 100);
  // 不允许出现半个实体（例如 &#91 后没有分号）。
  const stripped = result.text.slice(0, -"…(已截断)".length);
  const entities = stripped.match(/&#91;|&#93;|&amp;/gu) ?? [];
  const consumed = entities.join("");
  assert.equal(consumed, stripped);
});

test("各平台长度上限为保守值", () => {
  assert.equal(PLATFORM_TEXT_LIMITS.wechat, 2000);
  assert.equal(PLATFORM_TEXT_LIMITS.qq, 4500);
});

test("纯空白内容渲染为空串（runner 会按 isEmpty 跳过）", () => {
  const result = renderForTarget({ text: " \n\t ", targetPlatform: "qq" });
  assert.equal(result.text, "");
  assert.equal(result.truncated, false);
});
