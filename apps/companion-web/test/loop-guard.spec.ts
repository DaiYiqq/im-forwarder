import { test } from "node:test";
import assert from "node:assert/strict";

import { FingerprintGuard } from "../src/experimental/loop-guard.ts";

const SALT = new Uint8Array(32).fill(7);

function createClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("指纹回环：窗口期内同 group 同文本命中，跨窗口失效", async () => {
  const clock = createClock();
  const guard = new FingerprintGuard({ salt: SALT, now: clock.now, fingerprintWindowMs: 20_000 });

  await guard.rememberFingerprint("self-pair", "你好 世界");
  assert.equal(await guard.isFingerprintLoop("self-pair", "你好 世界"), true);

  // 空白归一化后相同也算命中。
  assert.equal(await guard.isFingerprintLoop("self-pair", " 你好   世界 "), true);

  clock.advance(20_001);
  assert.equal(await guard.isFingerprintLoop("self-pair", "你好 世界"), false);
});

test("指纹回环：不同 group 不互相命中", async () => {
  const clock = createClock();
  const guard = new FingerprintGuard({ salt: SALT, now: clock.now, fingerprintWindowMs: 20_000 });
  await guard.rememberFingerprint("group-a", "相同文本");
  assert.equal(await guard.isFingerprintLoop("group-b", "相同文本"), false);
});

test("指纹回环：不同盐生成不同摘要，无法跨实例命中", async () => {
  const clock = createClock();
  const first = new FingerprintGuard({ salt: SALT, now: clock.now });
  const second = new FingerprintGuard({ salt: new Uint8Array(32).fill(9), now: clock.now });
  await first.rememberFingerprint("g", "text");
  assert.equal(await second.isFingerprintLoop("g", "text"), false);
});

test("clear() 清空指纹表与回显表，且之后不再命中", async () => {
  const clock = createClock();
  const guard = new FingerprintGuard({ salt: SALT, now: clock.now });
  await guard.rememberFingerprint("g", "text");
  guard.rememberEcho({ platform: "qq", conversationId: "c1", messageId: "m1" });
  assert.deepEqual(guard.stats(), { echoes: 1, fingerprints: 1 });

  guard.clear();
  assert.deepEqual(guard.stats(), { echoes: 0, fingerprints: 0 });
  assert.equal(await guard.isFingerprintLoop("g", "text"), false);
  assert.equal(guard.lookupEcho({ platform: "qq", conversationId: "c1", messageId: "m1" }), false);
});

test("回显 messageId 层：命中后过期失效", () => {
  const clock = createClock();
  const guard = new FingerprintGuard({ salt: SALT, now: clock.now, echoTtlMs: 5_000 });
  guard.rememberEcho({ platform: "qq", conversationId: "conv", messageId: "msg-1" });
  assert.equal(guard.lookupEcho({ platform: "qq", conversationId: "conv", messageId: "msg-1" }), true);
  assert.equal(guard.lookupEcho({ platform: "qq", conversationId: "conv", messageId: "msg-2" }), false);
  assert.equal(guard.lookupEcho({ platform: "wechat", conversationId: "conv", messageId: "msg-1" }), false);

  clock.advance(5_001);
  assert.equal(guard.lookupEcho({ platform: "qq", conversationId: "conv", messageId: "msg-1" }), false);
});

test("指纹窗口为 0 时关闭指纹层（不阻塞任何消息）", async () => {
  const clock = createClock();
  const guard = new FingerprintGuard({ salt: SALT, now: clock.now, fingerprintWindowMs: 0 });
  await guard.rememberFingerprint("g", "text");
  assert.equal(await guard.isFingerprintLoop("g", "text"), false);
});

test("不注入盐时使用随机盐，且不抛错", async () => {
  const guard = new FingerprintGuard();
  await guard.rememberFingerprint("g", "text");
  assert.equal(await guard.isFingerprintLoop("g", "text"), true);
  assert.equal(guard.stats().fingerprints, 1);
});
