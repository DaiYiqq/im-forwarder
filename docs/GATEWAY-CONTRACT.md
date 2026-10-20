# 网关契约（Gateway Contract）

> 本文件描述 **im-forwarder 与「EasyBot 统一 IM 网关」之间的内部契约**。
>
> **来源声明（重要）**：这份契约来自本项目对"统一 IM 网关"的用法约定，
> **不是微信、QQ、Telegram 任何一家的官方规范，也不是某个具体网关产品的官方文档**。
> 对接任何真实网关之前，必须逐字段核对对方实际推送的 JSON 形状与 REST 路径，
> 并把差异收敛到 `fieldMap` 与配置项里（见文末「更换网关时改什么」）。
>
> 本服务只做"网关之上的转发路由"。它不登录微信、不登录 QQ、不实现 Telegram 协议，
> 也不解析/逆向任何平台报文。详见下方「边界声明」。

---

## 1. 在系统中的位置

```
[微信 iLink / QQ NapCat / Telegram Bot API]
                │  （各自官方或经授权的接入方式，全部由网关侧完成）
                ▼
        EasyBot 统一 IM 网关（外部进程）
                │  REST（发送）  +  WebSocket（接收）
                ▼
        im-forwarder（本仓库）
          ├─ src/gateway/     ← 唯一协议边界（本契约）
          ├─ src/routing/     ← 路由矩阵、解析、运行时策略链
          └─ src/...
```

本仓库源码只认识本文档描述的两种交互：

| 方向 | 传输 | 说明 |
| --- | --- | --- |
| 出站 | HTTP `POST {baseUrl}{sendPath}` | 发送纯文本消息 |
| 入站 | WebSocket `{wsUrl}` | 接收已归一化的消息事件 |

`src/gateway/contract.ts` 是类型层面的唯一事实来源；本文件是其行为说明。

---

## 2. 鉴权

两种通道使用同一套 Bearer Token：

```http
Authorization: Bearer <token>
```

- REST：每次 `POST` 都携带该请求头；网关缺失/错误时应返回 `401`。
- WebSocket：在握手请求头中携带（`ws` 库的 `headers` 选项）。
  WS 在浏览器里无法自定义请求头，但本服务是 Node 进程，没有这个限制。
- Token 的值**只从环境变量读取**（配置里只有环境变量名 `gateway.tokenEnv`），
  **不写入日志、不进入错误信息、不进入诊断回调**。

---

## 3. 入站：原始事件与字段映射

### 3.1 默认原始事件（`DEFAULT_FIELD_MAP` 对应的形状）

网关通过 WS 推送**一个 JSON 文本帧 = 一个事件对象**：

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
      "text": "你好，这是一条测试消息"
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

顶层 `type` 等其它字段本服务不读取；本服务只按 `fieldMap` 里的点号路径取值。

### 3.2 `fieldMap` 全部字段

`fieldMap` 的值是**点号路径**，支持数组下标（如 `data.messages.0.text`）。
未出现在映射里的字段一律忽略。默认值见 `DEFAULT_FIELD_MAP`。

| fieldMap 键 | 默认路径 | 含义 | 必需 | 归一化规则 |
| --- | --- | --- | --- | --- |
| `platform` | `data.platform` | 平台标识 | 是 | 仅接受 `wechat` / `qq` / `telegram`，否则整条事件丢弃 |
| `conversationId` | `data.conversation.id` | 会话 ID（路由端点之一） | 是 | 非空字符串；空白串视为非法，整条事件丢弃 |
| `chatType` | `data.conversation.type` | 会话类型 | 是 | 仅接受 `private` / `group`；**缺失或非法一律丢弃，绝不默认 private** |
| `messageId` | `data.message.id` | 消息 ID（去重键） | 是 | 非空字符串；拿不到就无法去重，丢弃 |
| `kind` | `data.message.kind` | 消息类型 | 否 | 命中 `text/image/file/video/voice/at/reply/emoji/unknown` 则用之，否则记为 `unknown` |
| `text` | `data.message.text` | 文本正文 | 条件 | 仅当 `kind === "text"` 时读取且必须是字符串；声明为 text 却没有字符串正文 → 整条丢弃。其它 kind 恒为 `null` |
| `senderId` | `data.sender.id` | 发送方 ID | 否 | 字符串则用之，否则 `""` |
| `senderIsSelf` | `data.sender.isSelf` | 是否本服务所登录账号自己发出（自回显过滤） | 否 | 仅接受 boolean，缺失/其它类型按 `false` |
| `senderIsBot` | `data.sender.isBot` | 发送方是否为机器人（防机器人互触发） | 否 | 仅接受 boolean，缺失/其它类型按 `false` |
| `timestamp` | `data.timestamp` | 事件时间戳，**毫秒** | 否 | 有限数字则取整使用，否则用服务本地 `Date.now()` |

归一化后的领域对象是 `IncomingMessage`（见 `src/types.ts`）：

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

### 3.3 归一化是 fail-closed 的

`normalizeGatewayEvent()` 对任何必填字段缺失、类型不符、值不在白名单的情况**返回 `null`**。
上层收到 `null` 时丢弃该事件并记录诊断码 `ws_unmapped_event`，绝不猜测、绝不补默认值。
这么设计的原因：

1. 没有 `messageId` 就无法幂等去重，重试会造成重复转发；
2. 把群聊误判成私聊会直接破坏"微信仅私聊"的合规约束，代价远高于丢一条消息；
3. 猜字段类型会把网关版本升级变成静默错乱，不如显式失败。

诊断只上报错误码（`ws_bad_frame` / `ws_unmapped_event`），**不打印原始帧内容**，
因为帧里可能含消息正文。

---

## 4. 出站：发送请求与响应

### 4.1 请求

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
    { "type": "text", "text": "你好，这是一条转发消息" }
  ],
  "idempotencyKey": "fwd_20250101_abcdef",
  "metadata": {
    "sourcePlatform": "wechat",
    "sourceMessageId": "msg_987654"
  }
}
```

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `platform` | `wechat` / `qq` / `telegram` | 是 | 目标平台 |
| `conversationId` | string | 是 | 目标会话 ID |
| `segments` | `{ type: "text", text: string }[]` | 是 | **只允许文本片段**；媒体在类型层面就不存在 |
| `idempotencyKey` | string | 是 | 幂等键；本服务重试或崩溃恢复时复用它，网关应据此去重 |
| `metadata` | `Record<string, string>` | 否 | 机器可读的非用户可见元数据；没有内容时本服务不发送该字段 |

`segments` 里绝不出现图片/文件 URL、base64、二维码、cookie、手机号等任何无关数据。

### 4.2 响应

成功：

```json
{ "ok": true, "messageId": "gw_msg_555" }
```

失败：

```json
{ "ok": false, "errorCode": "conversation_not_found" }
```

本服务只读取 `ok` 与 `messageId`：

- `ok === true` 且 `messageId` 为非空字符串 → 成功，`SendOutcome.messageId` 为该值；
- `ok === true` 但没有合法 `messageId` → 仍算成功，`messageId` 为 `null`；
- `ok === false` → 失败，`errorCode` 固定归一化为 `gateway_rejected`；
  **网关返回的原始 `errorCode` 不会被透传**（避免把远端字符串/报文带入本服务日志）；
- 2xx 但响应体不是合法 JSON 或没有 boolean `ok` → `gateway_bad_response`。

`SendOutcome`（见 `src/types.ts`）：

```ts
{ ok: boolean, messageId: string | null, errorCode: string | null, latencyMs: number }
```

`latencyMs` 是一次 `send()` 调用的总耗时（含重试等待），可用于观测。

### 4.3 超时与重试

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `timeoutMs` | `10000` | 单次 HTTP 尝试超时（`AbortSignal.timeout`） |
| `maxRetries` | `2` | 首次尝试之外的额外重试次数，即最多 `3` 次尝试 |

重试矩阵：

| 情况 | 是否重试 | 最终错误码 |
| --- | --- | --- |
| 网络错误（DNS/连接拒绝/连接重置） | 是 | `gateway_network` |
| 请求超时 | 是 | `gateway_timeout` |
| HTTP `429` | 是 | `gateway_http_429` |
| HTTP `5xx` | 是 | `gateway_http_<status>` |
| HTTP `4xx`（含 401/403） | **否** | `gateway_http_<status>` |
| 2xx 且 `ok: false` | **否** | `gateway_rejected` |
| 2xx 但响应体非法 | **否** | `gateway_bad_response` |
| 本地请求构造失败（URL 非法、metadata 循环引用等） | **否** | `gateway_bad_request` |

退避策略：`200ms * 2^(attempt-1)`，上限 5s，再叠加不超过 25% 的随机抖动。
所有重试共用同一个 `idempotencyKey`，因此网关侧可安全去重。
`send()` **从不抛异常**，任何失败都通过 `SendOutcome.ok === false` 返回。

### 4.4 错误码表（稳定、无正文）

| 错误码 | 产生位置 | 含义 |
| --- | --- | --- |
| `gateway_http_<status>` | client | 网关返回非 2xx；`<status>` 为三位 HTTP 状态码（如 `gateway_http_500`） |
| `gateway_timeout` | client / errors | 单次尝试超时（`AbortSignal.timeout`） |
| `gateway_network` | client / errors | DNS 失败、连接拒绝、连接重置等网络层错误 |
| `gateway_bad_response` | client | 2xx 但响应体不是合法 JSON，或缺少 boolean `ok` |
| `gateway_rejected` | client | 2xx 且 `ok: false`（业务层拒绝） |
| `gateway_bad_request` | client | 本地构造请求失败、endpoint 非法；不重试 |
| `gateway_unknown_error` | errors | 兜底归一化结果 |
| `ws_bad_frame` | events | 收到非 JSON 文本帧（只上报码，不打印内容） |
| `ws_unmapped_event` | events | 帧可解析但不满足契约（字段缺失/非法），已丢弃 |
| `ws_binary_frame_ignored` | events | 收到二进制帧，直接忽略 |
| `ws_handler_error` | events | 上层消息处理函数抛异常（不影响连接） |

诊断回调 `onDiagnostic(code, info?)` 只上报**元数据**，例如：

```ts
onDiagnostic("send_attempt", { attempt: 1, status: 0 });
onDiagnostic("send_retry", { attempt: 1, status: 500, delayMs: 213 });
onDiagnostic("gateway_http_500", { attempt: 3, status: 500 });
onDiagnostic("ws_reconnect_scheduled", { attempt: 2, delayMs: 2048 });
```

`info` 的值只允许 `string | number | boolean`，**不允许**任何消息正文、请求体、响应体、token。

---

## 5. 重连语义（WebSocket）

`WebSocketEventSource`：

1. 以 `wsUrl` 建连，握手头携带 `Authorization: Bearer <token>`；
2. `start(onMessage)` 在**首次连接建立**或**首次连接失败**后 resolve。
   首次失败时后台继续重连，因此不会出现"启动即挂死"；
3. `open` 之后 `close`/`error` 触发重连：默认 `1000ms` 起步，指数退避，
   `30000ms` 封顶，叠加随机抖动；连接成功后重试计数清零；
4. 每次重连只上报诊断码 `ws_reconnect_scheduled`，不打印 URL 之外的任何连接细节；
5. `stop()` 之后**不再重连**：清定时器、摘监听、`terminate()` 当前 socket；
   `stop()` 可重复调用，也可在从未 `start()` 时调用；
6. 收到的每个文本帧都会经过 `normalizeGatewayEvent`：
   - JSON 解析失败 → `ws_bad_frame`；
   - 归一化返回 `null` → `ws_unmapped_event`；
   - 成功 → 回调 `onMessage(IncomingMessage)`。

本服务不实现 WS 心跳/`pong` 业务语义；连接保活由 `ws` 库与网关负责。

---

## 6. 边界声明（本层绝对不做的事）

1. **不做任何平台登录 / 协议解析。**
   本仓库不存在任何微信登录、扫码、票据、登录态管理代码，也不依赖任何第三方微信协议库；
   不存在 QQ 登录代码；不存在 Telegram userbot（非官方客户端协议）代码。
2. **不直连任何平台官方接口。**
   出站只走配置中的网关 `baseUrl`；入站只连配置中的网关 `wsUrl`。
   本服务不会以任何平台官方域名为请求目标。
3. **微信侧的前提条件由网关保证。**
   网关必须保证推送的微信事件：
   - 只来自官方 **iLink（ClawBot）** 通道；
   - **仅私聊**消息。
   若网关仍推送了微信 `chatType === "group"` 的事件，本服务会在策略层直接丢弃
   （`skipped_group_forbidden`），绝不转发、也不做任何"群聊兼容"。
4. **Telegram 出站只对应 Bot API 形态。**
   userbot / 非官方客户端协议路径在本项目中不存在，也不允许新增。
5. **不记录消息正文。**
   不打印入站帧、请求体、响应体；日志与诊断只允许出现平台、路由 ID、状态、错误码、
   耗时、重试次数这类元数据。**`messageId` 也不在白名单内** —— 它虽不含正文，
   但可用于关联具体消息，属于不必要记录的标识（白名单见 `src/observability/logger.ts`）。
6. **不做媒体。**
   只转发文本；媒体消息会在策略层"显式回执 + 跳过"，本层不下载/解码任何媒体。

---

## 7. 更换网关时改什么

**只改两处，不改代码逻辑：**

1. **配置里的连接与路径**（与 `src/config/schema.ts` 的 `gateway` 段一致）
   ```yaml
   version: 1
   gateway:
     baseUrl: "http://127.0.0.1:8080"
     eventsUrl: "ws://127.0.0.1:8080/ws/events"
     # 只写环境变量名，token 本身不落配置文件
     tokenEnv: GATEWAY_TOKEN
     send:
       path: "/api/v1/messages/send"
     requestTimeoutMs: 10000
     maxRetries: 2
   ```
   代码层的对应关系：
   `new HttpGatewayClient({ baseUrl, sendPath: gateway.send.path, token, timeoutMs: gateway.requestTimeoutMs, maxRetries })`；
   `new WebSocketEventSource({ wsUrl: gateway.eventsUrl, token, fieldMap })`。
2. **配置里的 `fieldMap`**（只写与默认值不同的项即可）
   ```yaml
   gateway:
     fieldMap:
       platform: "platform"
       conversationId: "chat.id"
       chatType: "chat.kind"        # 例如对方叫 kind，值为 private/group
       messageId: "msgId"
       kind: "msgType"
       text: "content.text"
       senderId: "from.uid"
       senderIsSelf: "from.self"
       senderIsBot: "from.bot"
       timestamp: "ts"
   ```
   `fieldMap` 只允许覆盖 `DEFAULT_FIELD_MAP` 中已有的键；写未知键会被配置加载层拒绝。

**禁止的"适配方式"**：为了适配某个网关而在本仓库 import 平台 SDK、实现协议、
或直连平台接口。若对方网关字段语义与本文档冲突（例如没有 `chatType`、时间戳是秒），
正确做法是让网关补齐/改造，或在 `src/gateway/mapping.ts` 这一层做显式的、经过评审的转换，
并在本文档记录差异。

> 注意：`timestamp` 期望毫秒。若网关给的是秒级时间戳，需要在映射层显式乘以 1000，
> 并在契约文档登记，不能靠"看起来差不多"蒙混。

---

## 8. 本地 mock 网关

`scripts/mock-gateway.ts` 是**开发/测试用替身，不是任何真实网关的实现**：

```bash
npm run mock -- --port 8080 --token dev-token --echo --emit-demo
```

- REST：`POST /api/v1/messages/send`，若提供 `--token` 则校验 Bearer token，
  返回 `{"ok":true,"messageId":"mock-<n>"}`，并把请求记录到 `sent` 数组；
- WS：`/ws/events`（挂在同一 HTTP server 的 `upgrade` 上），可广播 JSON 文本帧；
- `--echo`：把收到的发送请求当作目标会话的新入站消息回推（`senderIsSelf: true`），
  用于演示/测试回环防护；
- `--emit-demo`：启动 1 秒后推送一条微信私聊演示事件；
- 默认 `--port 0`（随机端口），启动横幅会打印实际 `http://...` 与 `ws://...` 地址；
- 测试中可直接 `import { startMockGateway } from "../scripts/mock-gateway"`，
  用 `mock.rawEvent({...})` 构造契约形状事件、`mock.emit(event)` 广播、`mock.sent` 断言请求。

mock 网关同样不包含任何平台登录或协议代码；它只是本地 HTTP + WebSocket 的玩具实现。

---

## 9. 契约变更流程

1. 修改 `src/gateway/contract.ts` 的类型（或本文档）→ 2. 同步 `mapping.ts` / `client.ts`
→ 3. 更新 `DEFAULT_FIELD_MAP` 与 mock → 4. 更新本文档 → 5. 过 `npm run check`
（typecheck + 合规扫描 + 测试）。任何一步缺失都视为契约破裂。
