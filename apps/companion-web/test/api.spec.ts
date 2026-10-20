import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CompanionApi,
  CompanionApiError,
  LOG_FIELD_WHITELIST,
  pickLogFields,
} from "../src/api.ts";

const BASE = "http://192.168.1.8:3210";

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
}

function recordingFetch(
  responder: (request: CapturedRequest) => Response | Promise<Response>,
): { fetchImpl: (input: string, init?: RequestInit) => Promise<Response>; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  return {
    requests,
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      const captured: CapturedRequest = {
        url: input,
        method: init?.method ?? "GET",
        authorization: headers.get("Authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      };
      requests.push(captured);
      return await responder(captured);
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("配对：成功返回 token，且请求体只含 6 位配对码", async () => {
  const { fetchImpl, requests } = recordingFetch(() =>
    jsonResponse(200, { token: "tkn", expiresAt: "2030-01-01T00:00:00.000Z" }),
  );
  const api = new CompanionApi(BASE, "", { fetchImpl });
  const result = await api.pair("123456");
  assert.equal(result.token, "tkn");
  assert.equal(requests[0]?.url, `${BASE}/api/pair`);
  assert.equal(requests[0]?.authorization, null);
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), { code: "123456" });
});

test("配对码格式错误时不发请求", async () => {
  const { fetchImpl, requests } = recordingFetch(() => jsonResponse(200, { token: "x" }));
  const api = new CompanionApi(BASE, "", { fetchImpl });
  await assert.rejects(async () => await api.pair("abc"), (error: unknown) => {
    return error instanceof CompanionApiError && error.kind === "bad_response";
  });
  assert.equal(requests.length, 0);
});

test("需要鉴权的接口携带 Bearer，健康检查不带", async () => {
  const { fetchImpl, requests } = recordingFetch((request) => {
    if (request.url.endsWith("/api/health")) return jsonResponse(200, { ok: true, app: "im-forwarder", version: "0.2.0" });
    if (request.url.endsWith("/api/status")) {
      return jsonResponse(200, {
        running: false,
        startedAt: null,
        routeCount: 2,
        gateway: { baseUrlHost: "gw.local" },
        crossBorderOpen: false,
        counts: { forwarded: 1, failed: 0, skipped: 3 },
      });
    }
    return jsonResponse(404, {});
  });

  const api = new CompanionApi(BASE, "mem-token", { fetchImpl });
  await api.health();
  await api.status();

  assert.equal(requests[0]?.url, `${BASE}/api/health`);
  assert.equal(requests[0]?.authorization, null);
  assert.equal(requests[1]?.authorization, "Bearer mem-token");
});

test("401 → 中文可操作提示（重新配对），且不暴露令牌", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(401, { error: "unauthorized" }));
  const api = new CompanionApi(BASE, "mem-token", { fetchImpl });
  await assert.rejects(async () => await api.status(), (error: unknown) => {
    assert.ok(error instanceof CompanionApiError);
    assert.equal(error.kind, "unauthorized");
    assert.equal(error.status, 401);
    assert.ok(error.message.includes("重新配对"));
    assert.equal(error.message.includes("mem-token"), false);
    return true;
  });
});

test("409 → 保留 violations 逐条展示", async () => {
  const violations = ["路由 wx-to-tg 含 Telegram 出境边", "contentOwner=third-party 缺少告知"];
  const { fetchImpl } = recordingFetch(() => jsonResponse(409, { error: "preflight_failed", violations }));
  const api = new CompanionApi(BASE, "t", { fetchImpl });
  await assert.rejects(async () => await api.control("start"), (error: unknown) => {
    assert.ok(error instanceof CompanionApiError);
    assert.equal(error.kind, "conflict");
    assert.deepEqual(error.violations, violations);
    assert.ok(error.message.includes("预检"));
    return true;
  });
});

test("429 → 带 Retry-After 的中文提示", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(429, {}, { "Retry-After": "7" }));
  const api = new CompanionApi(BASE, "t", { fetchImpl });
  await assert.rejects(async () => await api.logs(10), (error: unknown) => {
    assert.ok(error instanceof CompanionApiError);
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryAfterSeconds, 7);
    assert.ok(error.message.includes("7 秒"));
    return true;
  });
});

test("503 → 桌面端暂不可用提示", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(503, {}));
  const api = new CompanionApi(BASE, "t", { fetchImpl });
  await assert.rejects(async () => await api.status(), (error: unknown) => {
    assert.ok(error instanceof CompanionApiError);
    assert.equal(error.kind, "unavailable");
    assert.ok(error.message.includes("稍后重试"));
    return true;
  });
});

test("连接失败 → 同局域网 / 局域网开关 / 防火墙 三条提示", async () => {
  const fetchImpl = async (): Promise<Response> => {
    throw new TypeError("fetch failed");
  };
  const api = new CompanionApi(BASE, "t", { fetchImpl });
  await assert.rejects(async () => await api.health(), (error: unknown) => {
    assert.ok(error instanceof CompanionApiError);
    assert.equal(error.kind, "network");
    assert.ok(error.message.includes("同一局域网"));
    assert.ok(error.message.includes("局域网访问"));
    assert.ok(error.message.includes("防火墙"));
    return true;
  });
});

test("日志只保留白名单字段，正文/未知字段一律丢弃", () => {
  const raw = {
    ts: 1_700_000_000_000,
    level: "info",
    event: "forward",
    routeId: "r1",
    sourcePlatform: "wechat",
    targetPlatform: "qq",
    status: "forwarded",
    latencyMs: 12,
    // 下面这些都不在白名单里：
    text: "这是消息正文，绝不能显示",
    conversationId: "conv_secret",
    senderId: "user_secret",
    nested: { content: "x" },
  };
  const row = pickLogFields(raw);
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes("消息正文"), false);
  assert.equal(serialized.includes("conv_secret"), false);
  assert.equal(serialized.includes("user_secret"), false);
  assert.equal(row.status, "forwarded");
  assert.equal(row.latencyMs, 12);
  // 白名单之外的类型（对象）被丢弃。
  assert.equal("nested" in row, false);
});

test("超长字符串不保留前 N 个字符，而是整体替换为占位符", () => {
  const tooLong = "x".repeat(LOG_FIELD_WHITELIST.length + 300);
  const row = pickLogFields({ errorCode: tooLong });
  assert.equal(typeof row.errorCode, "string");
  assert.ok(String(row.errorCode).startsWith("[omitted:"));
  assert.equal(String(row.errorCode).includes("xxxx"), false);
});

test("路由展示只含脱敏字段（即使服务端误发会话 ID 也不显示）", async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(200, [
      {
        id: "wx-to-qq",
        group: "self-pair",
        contentOwner: "self",
        from: { platform: "wechat", chatType: "private", conversationId: "conv_wx_secret" },
        to: [{ platform: "qq", chatType: "private", conversationId: "conv_qq_secret", receiver: { name: "secret" } }],
      },
    ]),
  );
  const api = new CompanionApi(BASE, "t", { fetchImpl });
  const routes = await api.routes();
  assert.equal(routes.length, 1);
  const serialized = JSON.stringify(routes);
  assert.equal(serialized.includes("conv_wx_secret"), false);
  assert.equal(serialized.includes("conv_qq_secret"), false);
  assert.equal(serialized.includes("receiver"), false);
  assert.equal(routes[0]?.from, "微信 · 私聊");
  assert.deepEqual(routes[0]?.to, ["QQ · 私聊"]);
});

test("status 响应形状不对时给出 bad_response（不静默用默认值冒充）", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { routes: [] }));
  const api = new CompanionApi(BASE, "t", { fetchImpl });
  await assert.rejects(async () => await api.status(), (error: unknown) => {
    return error instanceof CompanionApiError && error.kind === "bad_response";
  });
});
