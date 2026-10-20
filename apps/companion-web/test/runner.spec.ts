import { test } from "node:test";
import assert from "node:assert/strict";

import { FingerprintGuard } from "../src/experimental/loop-guard.ts";
import { validateBModeRoutes, type BModeRoute } from "../src/experimental/routing.ts";
import {
  BModeRunner,
  type GatewayPort,
  type GatewayStatusLike,
  type RunnerView,
} from "../src/experimental/runner.ts";
import type { GatewaySendResult, IncomingGatewayMessage } from "../src/experimental/gateway.ts";

const SALT = new Uint8Array(32).fill(3);

class FakeGateway implements GatewayPort {
  readonly sent: { platform: string; conversationId: string; text: string; idempotencyKey: string }[] = [];
  closed = false;
  connects = 0;
  private sequence = 0;

  async connect(): Promise<void> {
    this.connects += 1;
  }

  close(): void {
    this.closed = true;
  }

  async sendText(input: {
    platform: "wechat" | "qq" | "telegram";
    conversationId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<GatewaySendResult> {
    if (this.closed) return { ok: false, messageId: null, errorCode: "gateway_not_connected" };
    this.sequence += 1;
    this.sent.push({ ...input });
    return { ok: true, messageId: `sent_${this.sequence}`, errorCode: null };
  }
}

function routesForTests(): BModeRoute[] {
  const result = validateBModeRoutes([
    {
      id: "wx-to-qq",
      group: "self-pair",
      contentOwner: "self",
      from: { platform: "wechat", conversationId: "wx_self", chatType: "private" },
      to: [{ platform: "qq", conversationId: "qq_self", chatType: "private" }],
    },
    {
      id: "qq-to-wx",
      group: "self-pair",
      contentOwner: "self",
      from: { platform: "qq", conversationId: "qq_self", chatType: "private" },
      to: [{ platform: "wechat", conversationId: "wx_self", chatType: "private" }],
    },
  ]);
  assert.deepEqual(result.violations, []);
  return result.routes;
}

interface Harness {
  runner: BModeRunner;
  gateway: FakeGateway;
  guard: FingerprintGuard;
  views: RunnerView[];
  triggerHidden: () => void;
}

async function createHarness(options: { withVisibility?: boolean; now?: () => number } = {}): Promise<Harness> {
  let hiddenCallback: (() => void) | null = null;
  const views: RunnerView[] = [];
  const gateway = new FakeGateway();
  const guard = new FingerprintGuard({ salt: SALT, now: options.now });

  const runner = new BModeRunner({
    routes: routesForTests(),
    now: options.now,
    createGateway: (callbacks: {
      onMessage: (message: IncomingGatewayMessage) => void;
      onStatus: (status: GatewayStatusLike) => void;
    }): GatewayPort => {
      callbacks.onStatus({ state: "open", code: null });
      return gateway;
    },
    createGuard: () => guard,
    onUpdate: (view) => views.push(view),
    ...(options.withVisibility === true
      ? {
          visibility: {
            subscribe: (onHidden: () => void) => {
              hiddenCallback = onHidden;
              return () => {
                hiddenCallback = null;
              };
            },
          },
        }
      : {}),
  });

  await runner.start();
  return {
    runner,
    gateway,
    guard,
    views,
    triggerHidden: () => hiddenCallback?.(),
  };
}

function message(overrides: Partial<IncomingGatewayMessage> = {}): IncomingGatewayMessage {
  return {
    platform: "wechat",
    conversationId: "wx_self",
    chatType: "private",
    messageId: "m1",
    senderIsSelf: false,
    senderIsBot: false,
    kind: "text",
    text: "hello",
    receivedAt: 1,
    ...overrides,
  };
}

function lastStatus(harness: Harness): string | undefined {
  const logs = harness.runner.view().logs;
  return logs[logs.length - 1]?.status;
}

test("合法私聊文本被转发，且 CQ 码在发往 QQ 前被转义", async () => {
  const harness = await createHarness();
  await harness.runner.handleMessage(message({ text: "[CQ:at,qq=all] 你好" }));

  assert.equal(harness.gateway.sent.length, 1);
  assert.equal(harness.gateway.sent[0]?.platform, "qq");
  assert.equal(harness.gateway.sent[0]?.conversationId, "qq_self");
  assert.equal(harness.gateway.sent[0]?.text, "&#91;CQ:at,qq=all&#93; 你好");

  const view = harness.runner.view();
  assert.equal(view.counters.forwarded, 1);
  assert.equal(view.logs[0]?.status, "forwarded");
});

test("媒体消息显式提示后跳过，绝不下发网关", async () => {
  const harness = await createHarness();
  await harness.runner.handleMessage(
    message({ kind: "image", text: null, messageId: "m-img" }),
  );
  assert.equal(harness.gateway.sent.length, 0);
  const view = harness.runner.view();
  assert.equal(view.counters.skipped, 1);
  assert.equal(view.logs[0]?.status, "skipped_unsupported_kind");
  assert.ok(view.notices.some((notice) => notice.text.includes("非文本")));
});

test("群聊消息跳过；Telegram 平台消息跳过", async () => {
  const harness = await createHarness();
  await harness.runner.handleMessage(message({ chatType: "group", conversationId: "wx_group" }));
  assert.equal(harness.gateway.sent.length, 0);
  assert.equal(lastStatus(harness), "skipped_group_forbidden");

  await harness.runner.handleMessage(
    message({ platform: "telegram", conversationId: "tg_1", messageId: "m-tg" }),
  );
  assert.equal(harness.gateway.sent.length, 0);
  assert.equal(lastStatus(harness), "skipped_telegram_forbidden");
});

test("自己发出的消息与机器人消息都跳过（防互触发/回显）", async () => {
  const harness = await createHarness();
  await harness.runner.handleMessage(message({ senderIsSelf: true, messageId: "m-self" }));
  assert.equal(lastStatus(harness), "skipped_self");

  await harness.runner.handleMessage(message({ senderIsBot: true, messageId: "m-bot" }));
  assert.equal(lastStatus(harness), "skipped_bot");
  assert.equal(harness.gateway.sent.length, 0);
});

test("无匹配路由直接跳过（不会误发到其它会话）", async () => {
  const harness = await createHarness();
  await harness.runner.handleMessage(message({ conversationId: "wx_other" }));
  assert.equal(harness.gateway.sent.length, 0);
  assert.equal(harness.runner.view().logs[0]?.status, "skipped_no_route");
});

test("回显 messageId 层拦截：目标侧回推同一 messageId 不二次转发", async () => {
  const harness = await createHarness();
  await harness.runner.handleMessage(message({ text: "回声测试", messageId: "m-echo" }));
  assert.equal(harness.gateway.sent.length, 1);
  const echoedId = "sent_1";

  // 网关把刚发出的消息作为 QQ 入站回推（chatType private，走 qq→wx 路由）。
  await harness.runner.handleMessage(
    message({
      platform: "qq",
      conversationId: "qq_self",
      chatType: "private",
      messageId: echoedId,
      text: "回声测试",
    }),
  );

  assert.equal(harness.gateway.sent.length, 1);
  assert.equal(lastStatus(harness), "skipped_echo");
});

test("内容指纹层拦截：不同 messageId 的同文本回流被判回环", async () => {
  const harness = await createHarness();
  await harness.runner.handleMessage(message({ text: "同一段内容", messageId: "m-a" }));
  assert.equal(harness.gateway.sent.length, 1);

  await harness.runner.handleMessage(
    message({
      platform: "qq",
      conversationId: "qq_self",
      messageId: "different-id",
      text: "同一段内容",
    }),
  );

  assert.equal(harness.gateway.sent.length, 1);
  assert.equal(lastStatus(harness), "skipped_loop_suspected");
});

test("转发元数据日志不包含正文；视图 JSON 不泄漏消息内容", async () => {
  const harness = await createHarness();
  const secret = "绝密正文-SECRET-CONTENT";
  await harness.runner.handleMessage(message({ text: secret }));
  const serialized = JSON.stringify(harness.runner.view());
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("SECRET"), false);
});

test("停止：关闭网关（清空令牌）、清空指纹表、之后消息不再处理", async () => {
  const harness = await createHarness();
  await harness.runner.handleMessage(message({ text: "before-stop" }));
  assert.equal(harness.guard.stats().fingerprints, 1);

  await harness.runner.stop("用户手动停止");
  assert.equal(harness.gateway.closed, true);
  assert.equal(harness.runner.isRunning, false);
  assert.deepEqual(harness.guard.stats(), { echoes: 0, fingerprints: 0 });

  const sentBefore = harness.gateway.sent.length;
  await harness.runner.handleMessage(message({ text: "after-stop", messageId: "m-after" }));
  assert.equal(harness.gateway.sent.length, sentBefore);
});

test("页面切后台（visibilitychange）立即停止", async () => {
  const harness = await createHarness({ withVisibility: true });
  assert.equal(harness.runner.isRunning, true);

  harness.triggerHidden();
  // stop() 内部有 await 前的同步清理，但也等一个宏任务确保完成。
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.runner.isRunning, false);
  assert.equal(harness.gateway.closed, true);
  assert.ok(harness.runner.view().stoppedReason?.includes("后台"));
});

test("日志上限为 20 条", async () => {
  const harness = await createHarness();
  for (let index = 0; index < 25; index += 1) {
    await harness.runner.handleMessage(
      message({ conversationId: "wx_unknown", messageId: `m-${index}` }),
    );
  }
  const view = harness.runner.view();
  assert.equal(view.logs.length, 20);
  assert.equal(view.counters.skipped, 25);
});
