# Gateway Contract

> **Language / 语言**：[English](GATEWAY-CONTRACT.en.md) | [简体中文](../GATEWAY-CONTRACT.md)
> English translation of `docs/GATEWAY-CONTRACT.md`; the Simplified Chinese version is authoritative.

> This document describes the **internal contract between im-forwarder and the "EasyBot unified IM gateway"**.
>
> **Source statement (important)**: this contract comes from this project's usage conventions for "a unified IM gateway".
> It is **not the official specification of WeChat, QQ or Telegram, and it is not the official documentation of any specific gateway product** —
> put plainly, it is **not an official spec of any gateway vendor**.
> Before integrating with any real gateway, you must check field by field the JSON shapes and REST paths that the other side actually pushes,
> and fold the differences into `fieldMap` and the configuration items (see "What to change when you switch gateways" at the end of this document).
>
> This service only does "forwarding routing on top of a gateway". It does not log in to WeChat, does not log in to QQ, does not implement the Telegram protocol,
> and does not parse or reverse-engineer any platform's messages. See "Boundary statement" below.

---

## 1. Position in the system

```
[WeChat iLink / QQ NapCat / Telegram Bot API]
                │  (each platform's own official or authorized access path, all handled by the gateway side)
                ▼
        EasyBot unified IM gateway (external process)
                │  REST (send)  +  WebSocket (receive)
                ▼
        im-forwarder (this repository)
          ├─ src/gateway/     ← the only protocol boundary (this contract)
          ├─ src/routing/     ← routing matrix, resolution, runtime policy chain
          └─ src/...
```

This repository's source code knows only the two interactions described in this document:

| Direction | Transport | Description |
| --- | --- | --- |
| Outbound | HTTP `POST {baseUrl}{sendPath}` | Send a plain-text message |
| Inbound | WebSocket `{wsUrl}` | Receive already-normalized message events |

`src/gateway/contract.ts` is the single type-level source of truth; this document is its behavioural description.

---

## 2. Authentication

Both channels use the same Bearer token:

```http
Authorization: Bearer <token>
```

- REST: every `POST` carries this header; the gateway should return `401` when it is missing or wrong.
- WebSocket: carried in the handshake request headers (the `headers` option of the `ws` library).
  Browsers cannot set custom headers on WS, but this service is a Node process, so that limitation does not apply.
- The token value is **read from environment variables only** (the configuration holds nothing but the environment variable name `gateway.tokenEnv`),
  and is **never written to logs, never put into error messages, never passed into diagnostic callbacks**.

---

## 3. Inbound: raw events and field mapping

### 3.1 Default raw event (the shape that `DEFAULT_FIELD_MAP` corresponds to)

The gateway pushes over WS **one JSON text frame = one event object**:

```json
{
  "type": "message",
  "data": {
    "platform": "wechat",
    "conversation": {
      "id": "conv_123456",
      "type": "private"
    },
    "message": {
      "id": "msg_987654",
      "kind": "text",
      "text": "Hello, this is a test message"
    },
    "sender": {
      "id": "user_abc",
      "isSelf": false,
      "isBot": false
    },
    "timestamp": 1734567890123
  }
}
```

This service does not read the top-level `type` or any other field; it only reads values through the dot-separated paths in `fieldMap`.

### 3.2 All `fieldMap` fields

Values in `fieldMap` are **dot-separated paths**, and array indices are supported (e.g. `data.messages.0.text`).
Fields that do not appear in the mapping are ignored entirely. Defaults are given in `DEFAULT_FIELD_MAP`.

| fieldMap key | Default path | Meaning | Required | Normalization rule |
| --- | --- | --- | --- | --- |
| `platform` | `data.platform` | Platform identifier | Yes | Only `wechat` / `qq` / `telegram` are accepted; anything else drops the whole event |
| `conversationId` | `data.conversation.id` | Conversation ID (one endpoint of a route) | Yes | Non-empty string; a blank string counts as invalid and drops the whole event |
| `chatType` | `data.conversation.type` | Conversation type | Yes | Only `private` / `group` are accepted; **missing or invalid is always dropped, never defaulting to private** |
| `messageId` | `data.message.id` | Message ID (deduplication key) | Yes | Non-empty string; without it we cannot deduplicate, so drop |
| `kind` | `data.message.kind` | Message type | No | If it matches `text/image/file/video/voice/at/reply/emoji/unknown` it is used, otherwise it is recorded as `unknown` |
| `text` | `data.message.text` | Text body | Conditional | Read only when `kind === "text"`, and it must be a string; declared as text without a string body → drop the whole message. Always `null` for other kinds |
| `senderId` | `data.sender.id` | Sender ID | No | Use it if it is a string, otherwise `""` |
| `senderIsSelf` | `data.sender.isSelf` | Whether the message was sent by the account this service is logged in as (self-echo filtering) | No | Only boolean is accepted; missing or other types count as `false` |
| `senderIsBot` | `data.sender.isBot` | Whether the sender is a bot (prevents bots from triggering each other) | No | Only boolean is accepted; missing or other types count as `false` |
| `timestamp` | `data.timestamp` | Event timestamp, **milliseconds** | No | If it is a finite number, round it and use it; otherwise use the service's local `Date.now()` |

The normalized domain object is `IncomingMessage` (see `src/types.ts`):

```ts
{
  platform: "wechat" | "qq" | "telegram",
  conversationId: string,
  chatType: "private" | "group",
  messageId: string,
  senderId: string,
  senderIsSelf: boolean,
  senderIsBot: boolean,
  kind: MessageKind,
  text: string | null,
  receivedAt: number
}
```

### 3.3 Normalization is fail-closed

`normalizeGatewayEvent()` **returns `null`** for any required field that is missing, has the wrong type, or holds a value outside the allow-list.
When the upper layer receives `null` it drops the event and records the diagnostic code `ws_unmapped_event`; it never guesses and never fills in defaults.
Why it is designed this way:

1. Without a `messageId` there is no idempotent deduplication, and a retry would cause duplicate forwarding;
2. Mistaking a group chat for a private chat would directly break the "WeChat private chat only" compliance constraint, which costs far more than losing one message;
3. Guessing field types would turn a gateway version upgrade into silent corruption; an explicit failure is better.

Diagnostics report only error codes (`ws_bad_frame` / `ws_unmapped_event`) and **never print the raw frame content**,
because a frame may contain message bodies.

---

## 4. Outbound: send request and response

### 4.1 Request

```http
POST {baseUrl}{sendPath}
Content-Type: application/json
Authorization: Bearer <token>
Accept: application/json
```

```json
{
  "platform": "qq",
  "conversationId": "conv_123456",
  "segments": [
    { "type": "text", "text": "Hello, this is a forwarded message" }
  ],
  "idempotencyKey": "fwd_20250101_abcdef",
  "metadata": {
    "sourcePlatform": "wechat",
    "sourceMessageId": "msg_987654"
  }
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | `wechat` / `qq` / `telegram` | Yes | Target platform |
| `conversationId` | string | Yes | Target conversation ID |
| `segments` | `{ type: "text", text: string }[]` | Yes | **Text segments only**; media does not exist at the type level |
| `idempotencyKey` | string | Yes | Idempotency key; this service reuses it when retrying or recovering from a crash, and the gateway should deduplicate on it |
| `metadata` | `Record<string, string>` | No | Machine-readable, non-user-visible metadata; this service omits the field when there is nothing to send |

`segments` never contains image/file URLs, base64, QR codes, cookies, phone numbers, or any other unrelated data.

### 4.2 Response

Success:

```json
{ "ok": true, "messageId": "gw_msg_555" }
```

Failure:

```json
{ "ok": false, "errorCode": "conversation_not_found" }
```

This service reads only `ok` and `messageId`:

- `ok === true` and `messageId` is a non-empty string → success, and `SendOutcome.messageId` is that value;
- `ok === true` but there is no valid `messageId` → still a success, with `messageId` as `null`;
- `ok === false` → failure, with `errorCode` always normalized to `gateway_rejected`;
  **the raw `errorCode` returned by the gateway is not passed through** (to avoid carrying remote strings/payloads into this service's logs);
- 2xx but the response body is not valid JSON, or has no boolean `ok` → `gateway_bad_response`.

`SendOutcome` (see `src/types.ts`):

```ts
{ ok: boolean, messageId: string | null, errorCode: string | null, latencyMs: number }
```

`latencyMs` is the total duration of one `send()` call (including retry waits) and can be used for observability.

### 4.3 Timeouts and retries

| Configuration | Default | Description |
| --- | --- | --- |
| `timeoutMs` | `10000` | Timeout of a single HTTP attempt (`AbortSignal.timeout`) |
| `maxRetries` | `2` | Number of extra retries beyond the first attempt, i.e. at most `3` attempts |

Retry matrix:

| Situation | Retry? | Final error code |
| --- | --- | --- |
| Network error (DNS / connection refused / connection reset) | Yes | `gateway_network` |
| Request timeout | Yes | `gateway_timeout` |
| HTTP `429` | Yes | `gateway_http_429` |
| HTTP `5xx` | Yes | `gateway_http_<status>` |
| HTTP `4xx` (including 401/403) | **No** | `gateway_http_<status>` |
| 2xx with `ok: false` | **No** | `gateway_rejected` |
| 2xx but invalid response body | **No** | `gateway_bad_response` |
| Local request construction failure (invalid URL, cyclic metadata, etc.) | **No** | `gateway_bad_request` |

Backoff strategy: `200ms * 2^(attempt-1)`, capped at 5s, plus random jitter of no more than 25%.
All retries share the same `idempotencyKey`, so the gateway side can deduplicate safely.
`send()` **never throws**; every failure is returned through `SendOutcome.ok === false`.

### 4.4 Error code table (stable, no message bodies)

| Error code | Produced in | Meaning |
| --- | --- | --- |
| `gateway_http_<status>` | client | The gateway returned a non-2xx status; `<status>` is the three-digit HTTP status code (e.g. `gateway_http_500`) |
| `gateway_timeout` | client / errors | A single attempt timed out (`AbortSignal.timeout`) |
| `gateway_network` | client / errors | DNS failure, connection refused, connection reset and other network-layer errors |
| `gateway_bad_response` | client | 2xx but the response body is not valid JSON, or the boolean `ok` is missing |
| `gateway_rejected` | client | 2xx with `ok: false` (rejected at the business layer) |
| `gateway_bad_request` | client | Local request construction failed, or the endpoint is invalid; not retried |
| `gateway_unknown_error` | errors | Fallback normalization result |
| `ws_bad_frame` | events | A non-JSON text frame was received (the code is reported, the content is not printed) |
| `ws_unmapped_event` | events | The frame parses but does not satisfy the contract (missing/invalid fields); it has been dropped |
| `ws_binary_frame_ignored` | events | A binary frame was received and ignored outright |
| `ws_handler_error` | events | The upper-layer message handler threw (it does not affect the connection) |

The diagnostic callback `onDiagnostic(code, info?)` reports **metadata only**, for example:

```ts
onDiagnostic("send_attempt", { attempt: 1, status: 0 });
onDiagnostic("send_retry", { attempt: 1, status: 500, delayMs: 213 });
onDiagnostic("gateway_http_500", { attempt: 3, status: 500 });
onDiagnostic("ws_reconnect_scheduled", { attempt: 2, delayMs: 2048 });
```

`info` values may only be `string | number | boolean`; message bodies, request bodies, response bodies and tokens are **not allowed**.

---

## 5. Reconnection semantics (WebSocket)

`WebSocketEventSource`:

1. Connects to `wsUrl`, carrying `Authorization: Bearer <token>` in the handshake headers;
2. `start(onMessage)` resolves after **the first connection is established** or **the first connection attempt fails**.
   On a first failure it keeps reconnecting in the background, so "hangs forever at startup" does not happen;
3. After `open`, `close`/`error` triggers a reconnect: `1000ms` by default to start with, exponential backoff,
   capped at `30000ms`, with random jitter; the retry counter resets after a successful connection;
4. Each reconnect reports only the diagnostic code `ws_reconnect_scheduled`, and prints no connection detail other than the URL;
5. After `stop()` it **never reconnects**: clears timers, removes listeners, `terminate()`s the current socket;
   `stop()` may be called repeatedly, and may also be called when `start()` was never called;
6. Every text frame received goes through `normalizeGatewayEvent`:
   - JSON parsing fails → `ws_bad_frame`;
   - normalization returns `null` → `ws_unmapped_event`;
   - success → callback `onMessage(IncomingMessage)`.

This service does not implement WS heartbeat/`pong` business semantics; connection keep-alive is the responsibility of the `ws` library and the gateway.

---

## 6. Boundary statement (things this layer absolutely never does)

1. **No platform login / protocol parsing of any kind.**
   This repository contains no WeChat login, QR-code, ticket or session-state management code, and depends on no third-party WeChat protocol library;
   it contains no QQ login code; it contains no Telegram userbot (unofficial client protocol) code.
2. **No direct connections to any platform's official interface.**
   Outbound traffic goes only to the gateway `baseUrl` from the configuration; inbound traffic connects only to the gateway `wsUrl` from the configuration.
   This service never targets any platform's official domain.
3. **The WeChat-side preconditions are guaranteed by the gateway.**
   The gateway must guarantee that the WeChat events it pushes:
   - come only from the official **iLink (ClawBot)** channel;
   - are **private chat only**.
   If the gateway still pushes an event with WeChat `chatType === "group"`, this service drops it right in the policy layer
   (`skipped_group_forbidden`), never forwards it, and makes no "group chat compatibility" effort whatsoever.
4. **Telegram outbound corresponds only to the Bot API shape.**
   The userbot / unofficial client protocol path does not exist in this project and must not be added.
5. **No message bodies in records.**
   Inbound frames, request bodies and response bodies are not printed; logs and diagnostics may contain only metadata such as platform, route ID, status, error code,
   latency and retry count. **`messageId` is not on the allow-list either** — although it contains no body, it can be used to correlate a specific message,
   which makes it an identifier that need not be recorded (the allow-list is in `src/observability/logger.ts`).
6. **No media.**
   Only text is forwarded; media messages are "explicitly acknowledged + skipped" in the policy layer, and this layer neither downloads nor decodes any media.

---

## 7. What to change when you switch gateways

**Change two places only, not the code logic:**

1. **The connection and paths in the configuration** (consistent with the `gateway` section of `src/config/schema.ts`)
   ```yaml
   version: 1
   gateway:
     baseUrl: "http://127.0.0.1:8080"
     eventsUrl: "ws://127.0.0.1:8080/ws/events"
     # only the environment variable name; the token itself never enters the config file
     tokenEnv: GATEWAY_TOKEN
     send:
       path: "/api/v1/messages/send"
     requestTimeoutMs: 10000
     maxRetries: 2
   ```
   The corresponding code:
   `new HttpGatewayClient({ baseUrl, sendPath: gateway.send.path, token, timeoutMs: gateway.requestTimeoutMs, maxRetries })`;
   `new WebSocketEventSource({ wsUrl: gateway.eventsUrl, token, fieldMap })`.
2. **`fieldMap` in the configuration** (write only the entries that differ from the defaults)
   ```yaml
   gateway:
     fieldMap:
       platform: "platform"
       conversationId: "chat.id"
       chatType: "chat.kind"        # e.g. the other side calls it kind, with values private/group
       messageId: "msgId"
       kind: "msgType"
       text: "content.text"
       senderId: "from.uid"
       senderIsSelf: "from.self"
       senderIsBot: "from.bot"
       timestamp: "ts"
   ```
   `fieldMap` may only override keys already present in `DEFAULT_FIELD_MAP`; writing an unknown key is rejected by the configuration loader.

**Prohibited "adaptation approaches"**: importing a platform SDK into this repository, implementing a protocol,
or connecting directly to a platform interface in order to fit some gateway. If the other gateway's field semantics conflict with this document
(for example it has no `chatType`, or its timestamps are in seconds), the correct approach is to have the gateway supply or change them,
or to perform an explicit, reviewed conversion in `src/gateway/mapping.ts`, and to record the difference in this document.

> Note: `timestamp` is expected in milliseconds. If a gateway provides second-level timestamps, they must be explicitly multiplied by 1000
> in the mapping layer and registered in the contract document; do not paper it over by assuming "it looks close enough".

---

## 8. Local mock gateway

`scripts/mock-gateway.ts` is a **stand-in for development/testing, not an implementation of any real gateway**:

```bash
npm run mock -- --port 8080 --token dev-token --echo --emit-demo
```

- REST: `POST /api/v1/messages/send`; if `--token` is provided the Bearer token is verified,
  it returns `{"ok":true,"messageId":"mock-<n>"}`, and records the request in the `sent` array;
- WS: `/ws/events` (mounted on the same HTTP server's `upgrade`), able to broadcast JSON text frames;
- `--echo`: pushes each received send request back as a new inbound message in the target conversation (`senderIsSelf: true`),
  for demonstrating/testing loop protection;
- `--emit-demo`: pushes one WeChat private chat demo event 1 second after startup;
- `--port 0` by default (a random port); the startup banner prints the actual `http://...` and `ws://...` addresses;
- In tests you can directly `import { startMockGateway } from "../scripts/mock-gateway"`,
  build contract-shaped events with `mock.rawEvent({...})`, broadcast with `mock.emit(event)`, and assert on requests with `mock.sent`.

The mock gateway likewise contains no platform login or protocol code; it is just a toy local HTTP + WebSocket implementation.

---

## 9. Contract change process

1. Change the types in `src/gateway/contract.ts` (or this document) → 2. update `mapping.ts` / `client.ts`
→ 3. update `DEFAULT_FIELD_MAP` and the mock → 4. update this document → 5. pass `npm run check`
(typecheck + compliance scan + tests). If any step is missing, the contract is considered broken.
