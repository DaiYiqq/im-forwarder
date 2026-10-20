/**
 * 端到端（test/e2e-mock.spec.ts）。
 *
 * 用真实链路跑通一次转发：
 *   mock 网关（HTTP send + WebSocket events） → WebSocketEventSource
 *   → Forwarder → HttpGatewayClient → mock 网关。
 *
 * 注意：不使用任何真实平台/真实网络；端口为 0 由内核分配；
 * 结束必须 close()，否则 node --test 会因 open handle 挂住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RISK_NOTICE_VERSION } from "../src/config/schema";
import { runPreflight } from "../src/compliance/preflight";
import { HttpGatewayClient } from "../src/gateway/client";
import { WebSocketEventSource } from "../src/gateway/events";
import { Forwarder } from "../src/pipeline/forward";
import { startMockGateway, type MockGateway } from "../scripts/mock-gateway";
import type { ForwardStatus } from "../src/types";
import {
  endpoint,
  loadFromRaw,
  loopGuardFromConfig,
  rawConfig,
  route,
  silentLogger,
  sleep,
  target,
  TEST_ENV,
  TEST_TOKEN,
  waitFor,
} from "./fixtures/harness";

interface E2ERig {
  mock: MockGateway;
  statuses: ForwardStatus[];
  stop: () => Promise<void>;
}

/**
 * 启动 mock 网关 + 真实事件源 + 真实 Forwarder。
 * 配置走真实入口（临时 YAML → loadConfig → runPreflight），只是把网关地址换成 mock。
 */
async function startRig(mockOptions: Parameters<typeof startMockGateway>[0] = {}): Promise<E2ERig> {
  const mock = await startMockGateway({ port: 0, ...(mockOptions ?? {}) });

  const raw = rawConfig(
    [
      route({
        id: "wx-private-to-qq",
        group: "self-wx-qq",
        from: endpoint("wechat", "wxid_self"),
        to: [target("qq", "10001")],
      }),
      route({
        id: "qq-to-wx-private",
        group: "self-wx-qq",
        from: endpoint("qq", "10001"),
        to: [target("wechat", "wxid_self")],
      }),
    ],
    {
      gateway: {
        baseUrl: mock.httpUrl,
        eventsUrl: mock.wsUrl,
        requestTimeoutMs: 2000,
        maxRetries: 0,
      },
      compliance: {
        // 保持默认的出境闸门关闭；只是把日志级别调高，避免测试输出噪音
        telegramCrossBorder: {
          enabled: false,
          operator: null,
          acknowledgedAt: null,
          selfMessagesOnlyConfirmed: false,
          riskNoticeVersion: RISK_NOTICE_VERSION,
        },
        logLevel: "error",
      },
    },
  );

  const { config } = loadFromRaw(raw, TEST_ENV);
  const report = runPreflight({ config, env: TEST_ENV });
  assert.equal(
    report.ok,
    true,
    `e2e 配置必须是合规通过的配置，否则测的就不是正常链路。违规：${report.violations
      .map((violation) => violation.code)
      .join(", ")}`,
  );
  const matrix = report.matrix;
  assert.ok(matrix, "前置检查通过时必须得到路由矩阵");

  const client = new HttpGatewayClient({
    baseUrl: config.gateway.baseUrl,
    sendPath: config.gateway.sendPath,
    token: TEST_TOKEN,
    timeoutMs: 2000,
    maxRetries: 0,
  });

  const statuses: ForwardStatus[] = [];
  const forwarder = new Forwarder({
    config,
    matrix,
    gateway: client,
    consent: null,
    loopGuard: loopGuardFromConfig(config),
    logger: silentLogger("error"),
    crossBorderOpen: false,
  });

  const events = new WebSocketEventSource({
    wsUrl: config.gateway.eventsUrl,
    token: TEST_TOKEN,
    fieldMap: config.gateway.fieldMap,
  });

  await events.start((message) => {
    void forwarder.handle(message).then(
      (handled) => {
        statuses.push(...handled);
      },
      () => {
        statuses.push("send_failed");
      },
    );
  });

  return {
    mock,
    statuses,
    stop: async () => {
      await events.stop();
      await mock.close();
    },
  };
}

test("mock 网关端到端：微信私聊文本 → QQ 指定会话（HTTP + WS 真实链路）", async () => {
  const rig = await startRig();
  try {
    rig.mock.emit(
      rig.mock.rawEvent({
        platform: "wechat",
        conversationId: "wxid_self",
        chatType: "private",
        text: "hello",
      }),
    );

    await waitFor(() => rig.mock.sent.length === 1, {
      timeoutMs: 3000,
      label: "等待 mock 网关收到 1 条转发请求",
    });

    const sent = rig.mock.sent[0];
    assert.ok(sent, "应收到一条发送请求");
    assert.equal(sent.platform, "qq", "微信私聊消息必须被路由到 QQ");
    assert.equal(sent.conversationId, "10001");
    assert.equal(sent.segments[0]?.type, "text");
    assert.equal(sent.segments[0]?.text, "hello", "纯文本不应被改写（只做必要的清洗/转义）");

    await waitFor(() => rig.statuses.includes("forwarded"), {
      timeoutMs: 3000,
      label: "等待 Forwarder 返回 forwarded 状态",
    });
  } finally {
    await rig.stop();
  }
});

test("echoSentMessages 回推：自身消息被 skipped_self 拦截，不会无限转发", async () => {
  const rig = await startRig({ echoSentMessages: true });
  try {
    rig.mock.emit(
      rig.mock.rawEvent({
        platform: "wechat",
        conversationId: "wxid_self",
        chatType: "private",
        text: "echo-hello",
      }),
    );

    await waitFor(() => rig.mock.sent.length === 1, {
      timeoutMs: 3000,
      label: "等待首条转发完成",
    });
    await waitFor(() => rig.statuses.includes("skipped_self"), {
      timeoutMs: 3000,
      label: "等待回推事件被识别为自身消息（skipped_self）",
    });

    // 回推消息不得再触发任何发送；给足时间让潜在的循环暴露出来
    await sleep(500);
    assert.equal(
      rig.mock.sent.length,
      1,
      "合规要求：网关回推本服务自己发出的消息时不得再次转发（否则 A→B→A 无限循环）",
    );
  } finally {
    await rig.stop();
  }
});
