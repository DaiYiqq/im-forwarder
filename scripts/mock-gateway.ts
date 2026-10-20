/**
 * 本地 mock 网关：只用于开发联调与测试，不代表任何真实厂商网关实现。
 *
 * 它同时提供：
 *   - REST：POST /api/v1/messages/send（可选 Bearer token 校验），记录请求；
 *   - WS：  /ws/events（挂到同一个 HTTP server 的 upgrade），可广播事件；
 *   - echoSentMessages：把收到的发送请求当作目标会话的新入站消息回推，
 *     用于验证回环防护（senderIsSelf=true）。
 *
 * 本文件可被测试 import，也可作为 CLI 启动（npm run mock）。
 * 注意：CLI 模式只使用 Node 内置模块 + 项目内类型，不引入任何平台 SDK。
 */

import { createServer } from "node:http";
import type { IncomingMessage as NodeHttpRequest, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import type { GatewayRawEvent, GatewaySendRequest } from "../src/gateway/contract";

const SEND_PATH = "/api/v1/messages/send";
const WS_PATH = "/ws/events";
const MAX_BODY_BYTES = 1_000_000;
const PLATFORMS = ["wechat", "qq", "telegram"] as const;

export interface MockGatewayOptions {
  port?: number;
  token?: string;
  echoSentMessages?: boolean;
}

export interface MockGateway {
  httpUrl: string;
  wsUrl: string;
  /** 记录收到的所有发送请求（供测试断言） */
  sent: GatewaySendRequest[];
  /** 构造一条默认契约格式的原始事件（用 DEFAULT_FIELD_MAP 的路径形状） */
  rawEvent(overrides: {
    platform?: string;
    conversationId?: string;
    chatType?: string;
    messageId?: string;
    kind?: string;
    text?: string;
    senderId?: string;
    senderIsSelf?: boolean;
    senderIsBot?: boolean;
  }): GatewayRawEvent;
  /** 向所有已连接的 WS 客户端推送一条事件（JSON 文本帧） */
  emit(raw: GatewayRawEvent): void;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

async function readBody(req: NodeHttpRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("payload_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 宽松校验发送请求的最小形状；不合法请求返回 400，不进入 sent。 */
function isSendRequest(value: unknown): value is GatewaySendRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;

  if (typeof record.platform !== "string" || !(PLATFORMS as readonly string[]).includes(record.platform)) {
    return false;
  }
  if (!isNonEmptyString(record.conversationId) || !isNonEmptyString(record.idempotencyKey)) {
    return false;
  }
  if (!Array.isArray(record.segments) || record.segments.length === 0) {
    return false;
  }
  for (const segment of record.segments) {
    if (segment === null || typeof segment !== "object") {
      return false;
    }
    const item = segment as Record<string, unknown>;
    if (item.type !== "text" || typeof item.text !== "string") {
      return false;
    }
  }
  if (record.metadata !== undefined) {
    if (record.metadata === null || typeof record.metadata !== "object" || Array.isArray(record.metadata)) {
      return false;
    }
    for (const metadataValue of Object.values(record.metadata as Record<string, unknown>)) {
      if (typeof metadataValue !== "string") {
        return false;
      }
    }
  }
  return true;
}

export async function startMockGateway(options: MockGatewayOptions = {}): Promise<MockGateway> {
  const token =
    typeof options.token === "string" && options.token.length > 0 ? options.token : undefined;
  const echoSentMessages = options.echoSentMessages === true;
  const requestedPort =
    typeof options.port === "number" && Number.isInteger(options.port) && options.port >= 0 && options.port <= 65_535
      ? options.port
      : 0;

  const sent: GatewaySendRequest[] = [];
  let sentSeq = 0;
  let eventSeq = 0;
  let closed = false;

  const wss = new WebSocketServer({ noServer: true });
  // 未连接的 upgrade 请求不会进入 clients；这里只需要一个空的 connection 监听。
  wss.on("connection", () => {
    // 不保存单连接状态：广播时直接遍历 wss.clients。
  });

  function rawEvent(overrides: Parameters<MockGateway["rawEvent"]>[0] = {}): GatewayRawEvent {
    eventSeq += 1;
    const messageId = overrides.messageId ?? `mock-msg-${eventSeq}`;
    return {
      type: "message",
      data: {
        platform: overrides.platform ?? "wechat",
        conversation: {
          id: overrides.conversationId ?? `mock-conv-${eventSeq}`,
          type: overrides.chatType ?? "private",
        },
        message: {
          id: messageId,
          kind: overrides.kind ?? "text",
          text: overrides.text ?? "mock gateway inbound text",
        },
        sender: {
          id: overrides.senderId ?? "mock-user-1",
          isSelf: overrides.senderIsSelf ?? false,
          isBot: overrides.senderIsBot ?? false,
        },
        timestamp: Date.now(),
      },
    };
  }

  function emit(raw: GatewayRawEvent): void {
    const payload = JSON.stringify(raw);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  async function handleHttp(req: NodeHttpRequest, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(res, 400, { ok: false, errorCode: "bad_path" });
      return;
    }

    if (pathname !== SEND_PATH) {
      sendJson(res, 404, { ok: false, errorCode: "not_found" });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJson(res, 405, { ok: false, errorCode: "method_not_allowed" });
      return;
    }

    if (token !== undefined) {
      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${token}`) {
        sendJson(res, 401, { ok: false, errorCode: "unauthorized" });
        return;
      }
    }

    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendJson(res, 413, { ok: false, errorCode: "payload_too_large" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { ok: false, errorCode: "bad_request" });
      return;
    }

    if (!isSendRequest(parsed)) {
      sendJson(res, 400, { ok: false, errorCode: "bad_request" });
      return;
    }

    const request = parsed;
    sentSeq += 1;
    sent.push(request);
    const messageId = `mock-${sentSeq}`;
    sendJson(res, 200, { ok: true, messageId });

    // 演示/测试回环防护：把发出去的消息当目标会话的新入站消息回推。
    if (echoSentMessages) {
      const text = request.segments.find((segment) => segment.type === "text")?.text ?? "";
      emit(
        rawEvent({
          platform: request.platform,
          conversationId: request.conversationId,
          // 发送请求不带 chatType；回推事件默认按私聊构造（仅用于测试）。
          chatType: "private",
          kind: "text",
          text,
          senderId: "mock-gateway-self",
          senderIsSelf: true,
          senderIsBot: false,
        }),
      );
    }
  }

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, errorCode: "mock_internal_error" });
      } else {
        res.end();
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, "127.0.0.1");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock gateway failed to determine listening port");
  }
  const port = address.port;
  const httpUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${WS_PATH}`;

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;

    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // 已关闭的连接直接忽略。
      }
    }

    await new Promise<void>((resolve) => {
      try {
        wss.close(() => resolve());
      } catch {
        resolve();
      }
    });

    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      // 强制关闭 keep-alive 连接，避免测试进程因空闲 socket 挂住。
      server.closeAllConnections();
    });
  }

  return {
    httpUrl,
    wsUrl,
    sent,
    rawEvent,
    emit,
    close,
  };
}

interface CliOptions {
  port: number;
  token?: string;
  echoSentMessages: boolean;
  emitDemo: boolean;
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { port: 0, echoSentMessages: false, emitDemo: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--port") {
      const next = argv[index + 1];
      if (next !== undefined) {
        const parsed = Number.parseInt(next, 10);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535) {
          options.port = parsed;
        }
        index += 1;
      }
      continue;
    }
    if (arg === "--token") {
      const next = argv[index + 1];
      if (next !== undefined) {
        options.token = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--echo" || arg === "--echo-sent-messages") {
      options.echoSentMessages = true;
      continue;
    }
    if (arg === "--emit-demo") {
      options.emitDemo = true;
    }
  }

  return options;
}

async function runCli(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const options: MockGatewayOptions = {
    port: cli.port,
    echoSentMessages: cli.echoSentMessages,
  };
  if (cli.token !== undefined) {
    options.token = cli.token;
  }

  let gateway: MockGateway;
  try {
    gateway = await startMockGateway(options);
  } catch {
    process.stderr.write("mock gateway failed to start\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`mock gateway listening: ${gateway.httpUrl} | ws: ${gateway.wsUrl}\n`);
  if (cli.token !== undefined) {
    process.stdout.write("mock gateway auth: Authorization: Bearer <token> required\n");
  }
  if (cli.echoSentMessages) {
    process.stdout.write("mock gateway echo: sent messages are re-emitted as inbound (senderIsSelf=true)\n");
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void gateway.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  if (cli.emitDemo) {
    setTimeout(() => {
      gateway.emit(
        gateway.rawEvent({
          platform: "wechat",
          conversationId: "demo-wechat-private-001",
          chatType: "private",
          kind: "text",
          text: "mock gateway demo event (no real platform session involved)",
        }),
      );
    }, 1_000);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runCli();
}
