import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GATEWAY_FIELD_MAP,
  WS_APP_SUBPROTOCOL,
  WS_TOKEN_SUBPROTOCOL_PREFIX,
  base64UrlEncode,
  normalizeGatewayUrl,
  parseGatewayMessage,
} from "../src/experimental/gateway.ts";

function rawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    data: {
      platform: "wechat",
      conversation: { id: "conv_1", type: "private" },
      message: { id: "msg_1", kind: "text", text: "你好" },
      sender: { id: "u1", isSelf: false, isBot: false },
      timestamp: 1_700_000_000_000,
      ...overrides,
    },
  };
}

test("默认字段映射与核心契约一致", () => {
  assert.equal(GATEWAY_FIELD_MAP.platform, "data.platform");
  assert.equal(GATEWAY_FIELD_MAP.conversationId, "data.conversation.id");
  assert.equal(GATEWAY_FIELD_MAP.chatType, "data.conversation.type");
  assert.equal(GATEWAY_FIELD_MAP.messageId, "data.message.id");
  assert.equal(GATEWAY_FIELD_MAP.kind, "data.message.kind");
  assert.equal(GATEWAY_FIELD_MAP.text, "data.message.text");
  assert.equal(GATEWAY_FIELD_MAP.senderIsSelf, "data.sender.isSelf");
  assert.equal(GATEWAY_FIELD_MAP.senderIsBot, "data.sender.isBot");
  assert.equal(GATEWAY_FIELD_MAP.timestamp, "data.timestamp");
});

test("文本事件归一化成功", () => {
  const message = parseGatewayMessage(rawEvent());
  assert.ok(message);
  assert.equal(message.platform, "wechat");
  assert.equal(message.conversationId, "conv_1");
  assert.equal(message.chatType, "private");
  assert.equal(message.messageId, "msg_1");
  assert.equal(message.kind, "text");
  assert.equal(message.text, "你好");
  assert.equal(message.senderIsSelf, false);
  assert.equal(message.senderIsBot, false);
  assert.equal(message.receivedAt, 1_700_000_000_000);
});

test("非文本类型不携带正文（text 强制为 null）", () => {
  const message = parseGatewayMessage(
    rawEvent({ message: { id: "m2", kind: "image", text: "图片描述也不该带出" } }),
  );
  assert.ok(message);
  assert.equal(message.kind, "image");
  assert.equal(message.text, null);
});

test("kind 缺失或非法记为 unknown 且不带正文", () => {
  const missing = parseGatewayMessage(rawEvent({ message: { id: "m3", text: "x" } }));
  assert.ok(missing);
  assert.equal(missing.kind, "unknown");
  assert.equal(missing.text, null);

  const invalid = parseGatewayMessage(rawEvent({ message: { id: "m4", kind: "sticker", text: "x" } }));
  assert.ok(invalid);
  assert.equal(invalid.kind, "unknown");
  assert.equal(invalid.text, null);
});

test("必需字段缺失/类型错误时 fail-closed 返回 null", () => {
  assert.equal(parseGatewayMessage(null), null);
  assert.equal(parseGatewayMessage("not-an-object"), null);
  assert.equal(parseGatewayMessage({ data: {} }), null);
  // platform 非白名单
  assert.equal(parseGatewayMessage(rawEvent({ platform: "discord" })), null);
  // chatType 必须是 private/group，绝不默认 private
  assert.equal(parseGatewayMessage(rawEvent({ conversation: { id: "c", type: "channel" } })), null);
  // messageId 缺失
  assert.equal(parseGatewayMessage(rawEvent({ message: { kind: "text", text: "x" } })), null);
  // 声明 text 却没有字符串正文
  assert.equal(parseGatewayMessage(rawEvent({ message: { id: "m", kind: "text" } })), null);
  // conversationId 为空串
  assert.equal(parseGatewayMessage(rawEvent({ conversation: { id: "   ", type: "private" } })), null);
});

test("sender 布尔字段严格校验（非 true 一律 false），时间戳缺失用注入时钟", () => {
  const message = parseGatewayMessage(
    rawEvent({
      sender: { id: "u", isSelf: "true", isBot: 1 },
      timestamp: "not-a-number",
    }),
    () => 42,
  );
  assert.ok(message);
  assert.equal(message.senderIsSelf, false);
  assert.equal(message.senderIsBot, false);
  assert.equal(message.receivedAt, 42);
});

test("WS 地址归一化：ws/wss 允许，http 拒绝，内嵌凭据拒绝", () => {
  assert.deepEqual(normalizeGatewayUrl("192.168.1.8:18080/ws", "ws"), { url: "ws://192.168.1.8:18080/ws" });
  assert.deepEqual(normalizeGatewayUrl("wss://gw.example/ws?x=1", "ws"), { url: "wss://gw.example/ws?x=1" });
  assert.deepEqual(normalizeGatewayUrl("http://gw.example/ws", "ws"), { error: "WebSocket 地址只允许 ws:// 或 wss://" });
  assert.deepEqual(normalizeGatewayUrl("ws://user:pass@gw/ws", "ws"), { error: "地址中不能包含用户名或密码" });
  assert.deepEqual(normalizeGatewayUrl("", "ws"), { error: "请填写网关 WebSocket 地址" });
});

test("REST 地址归一化：只允许 http(s)，去掉路径尾部斜杠与查询串", () => {
  assert.deepEqual(normalizeGatewayUrl("192.168.1.8:18080/", "rest"), { url: "http://192.168.1.8:18080" });
  assert.deepEqual(normalizeGatewayUrl("https://gw.example/api/?a=1#f", "rest"), { url: "https://gw.example/api" });
  assert.deepEqual(normalizeGatewayUrl("ws://gw/ws", "rest"), { error: "REST 地址只允许 http:// 或 https://" });
});

test("子协议令牌编码为 base64url（不含 = / +，可安全放进 Sec-WebSocket-Protocol）", () => {
  assert.equal(base64UrlEncode("abc"), "YWJj");
  const encoded = base64UrlEncode("a+b/c=d?e");
  assert.equal(/^[A-Za-z0-9_-]+$/u.test(encoded), true);
  assert.equal(WS_TOKEN_SUBPROTOCOL_PREFIX, "bearer.");
  assert.equal(WS_APP_SUBPROTOCOL, "im-forwarder.v1");
});
