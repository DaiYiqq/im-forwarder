# 路由矩阵设计与运行语义

> **语言 / Language**：[简体中文](ROUTING.md) | [English](en/ROUTING.en.md)

本文说明 `routes:` 配置的语义、编译期规则、运行时策略链与回环防护。
对应源码：`src/routing/matrix.ts`、`src/routing/resolve.ts`、`src/routing/policy.ts`、`src/pipeline/loop-guard.ts`。

---

## 1. 模型：有向边集合，而不是"两两硬编码"

```
微信私聊 A ──┐                         ┌──▶ QQ 私聊 X
             ├── 路由矩阵（有向边）─────┤
QQ 私聊 X ───┘                         └──▶ 微信私聊 A
```

- 节点 = `平台:会话ID:会话类型`（例如 `wechat:wxid_abc:private`）
- 边 = 一条 `routes[]` 项：`from` → `to[]`（一个源可以扇出到多个目标，最多 8 个）
- 索引 = 编译期建立的 `源键 → 路由列表`，运行时 O(1) 命中
- **没有**"平台对平台"的内置特例。加一条微信→Telegram 的路由，与加一条微信→QQ 的路由，走的是同一套代码。

---

## 2. 配置字段

```yaml
routes:
  - id: wx-private-to-qq          # 必填，全局唯一
    group: self-wx-qq             # 必填，同一逻辑链路；回环防护与环检测按 group 判定
    contentOwner: self            # 必填：self | third-party（无默认值）
    from:
      platform: wechat
      conversationId: "wxid_xxx"
      chatType: private
    to:
      - platform: qq
        conversationId: "10001"
        chatType: private
        # 仅当 contentOwner=third-party 时必须提供：
        receiver:
          name: "接收方名称"
          contact: "联系方式"
          purpose: "处理目的"
          method: "处理方式"
          dataCategories: ["信息种类1", "信息种类2"]
          retention: "保存期限"
```

| 字段 | 约束 | 为什么 |
|---|---|---|
| `id` | 唯一 | 日志/审计定位 |
| `group` | 同 group 内 `contentOwner` 一致；环不得跨 group | 内容指纹按 group 生效，跨 group 环会让防护失效 |
| `contentOwner` | **无默认值** | 是否转发他人内容是事实问题，程序无法判断，必须人工声明 |
| `chatType` | 必须 `private`（所有平台） | 群聊无法逐成员取得同意（PIPL 第 23 条） |
| `to[].receiver` | third-party 时必填六项 | 第 23 条告知要素，缺项拒绝启动 |

---

## 3. 编译期规则（不满足 → 进程拒绝启动，exit 78）

| 规则 | 错误码 |
|---|---|
| 微信源/目标为群聊 | `WECHAT_GROUP_SOURCE_FORBIDDEN` / `WECHAT_GROUP_TARGET_FORBIDDEN` |
| 非微信平台群聊 | `GROUP_CHAT_UNSUPPORTED` |
| 自环（`from == to`） | `ROUTE_SELF_LOOP` |
| 重复 route id | `DUPLICATE_ROUTE_ID` |
| 重复边（相同 from→to） | `DUPLICATE_EDGE` |
| 同 group 内容归属冲突 | `GROUP_CONTENT_OWNER_CONFLICT` |
| 跨 group 的环 | `CYCLE_ACROSS_GROUPS` |
| 有环但 `loopGuard.enabled=false` | `LOOP_GUARD_REQUIRED` |
| 目标含 telegram 但出境闸门未开 | `CROSS_BORDER_GATE_CLOSED` / `CROSS_BORDER_ACK_INCOMPLETE` |
| third-party 但同意机制未开 | `THIRD_PARTY_CONSENT_DISABLED` |
| third-party 目标缺告知要素 | `THIRD_PARTY_NOTICE_MISSING` |
| third-party + 出境 且 `allowCrossBorder=false` | `THIRD_PARTY_CROSS_BORDER_FORBIDDEN` |
| `gateway.baseUrl/eventsUrl` 指向平台官方域名 | `DIRECT_PLATFORM_ENDPOINT` |

> 设计原则：**冲突不自动取舍**。两条路由互相矛盾时，宁可启动失败让你看清配置，也不要"猜一个能跑的组合"。

---

## 4. 运行时策略链

顺序固定，任何不确定都往"不转发"走：

| 步骤 | 判定 | 结果状态 |
|---|---|---|
| P0 | `senderIsSelf` | `skipped_self`（debug 日志） |
| P0 | `senderIsBot` | `skipped_bot`（防 bot 互踢） |
| P1 | `chatType !== private`（任何平台） | `skipped_group_forbidden` |
| P2 | 未命中路由 | `skipped_no_route`（debug 日志） |
| P3 | 回显 messageId 命中且 `hop+1 > maxHops` | `skipped_loop_suspected` |
| P4 | `kind !== "text"` | 向源会话回执 → `skipped_unsupported_kind` |
| P5 | 出境边且闸门未开（兜底） | `blocked_cross_border` |
| P6 | 短期内容指纹命中 | `skipped_loop_suspected` |
| P7 | third-party 且缺少同意 | 发告知 → `blocked_consent_pending` |
| P8 | 其余 | `forwarded` / `send_failed` |

一个源会话可以同时命中多条路由（扇出）。每条路由独立判定，互不影响。

---

## 5. 回环防护（三层）

### 第 1 层：回显 messageId（主）

发送成功后，把目标侧返回的 `messageId` 记入内存表：
`(targetPlatform, targetConversationId, messageId) → (group, hop)`。
网关若把这条消息作为"新入站消息"回推，直接识别为自身回显。

### 第 2 层：短期内容指纹（兜底）

适配器不返回 `messageId` 时，用**每进程随机盐**对文本做 HMAC-SHA256，
在 `fingerprintWindowMs`（默认 20s）窗口内比对同 group 的回流文本。
指纹只在内存中，不落盘、不打印、进程退出即消失。

### 第 3 层：hop 预算

- `maxHops: 1`（默认）：本服务转发过的消息**不再二次转发** —— 任何回显都会被丢弃；
- `maxHops: 2`：允许链路再走一跳（A→B→C），第二跳之后仍会丢弃。
- hop 计数依附于回显记录，因此**只在网关回传 messageId 时精确**；不返回 ID 时由指纹层兜底。

### 典型场景

```
微信 ──(转发, messageId=mock-1)──▶ QQ
QQ  ──(网关回推 messageId=mock-1)──▶ 本服务
                                     ├─ maxHops=1 → hop+1=2 > 1 → 丢弃 ✅
                                     └─ maxHops=2 → 允许再转发一次，hop=2
```

---

## 6. 常见故障与含义

| 现象 | 含义 | 处理 |
|---|---|---|
| 启动即 exit 78，报 `LOOP_GUARD_REQUIRED` | 有双向路由但关闭了回环防护 | 恢复 `loopGuard.enabled=true` |
| 消息都进 `skipped_no_route` | `conversationId` 与该平台实际会话 ID 不一致 | 查网关事件日志（注意：本服务不打印会话 ID，需在网关侧查） |
| `blocked_consent_pending` 反复出现 | 对方未回复同意关键词 | 正常；对方回复「同意转发」后自动恢复 |
| `send_failed` + `gateway_http_4xx` | 目标会话 ID 错、bot 未进会话、网关鉴权失败 | 查网关，不是本服务的问题 |
| 转发成功但对方立刻又收到一次 | 回显未被识别 | 确认网关是否返回 `messageId`；降低 `fingerprintWindowMs` 不解决问题，应修网关 |
| `ws_unmapped_event` 大量出现 | `fieldMap` 与网关字段不匹配 | 改 `gateway.fieldMap`，见 [GATEWAY-CONTRACT.md](GATEWAY-CONTRACT.md) |

---

## 7. 设计取舍（为什么这样做）

1. **显式双向，而不是 `bidirectional: true` 糖**：两条边各自可审阅、可单独禁用，审计时一目了然。
2. **群聊整体不支持，而不是"只限微信"**：群内无法逐成员取得同意，做一半比不做更危险。
3. **不支持"发给所有人"**：扇出目标必须逐个写进配置，避免误把私聊内容扩散。
4. **不自动重试失败的业务错误**：4xx 重试只会放大错误（网关层只重试网络/5xx/429）。
5. **不做消息排队**：队列落盘 = 持久化正文，与需求第 8 条冲突。代价是发送失败即丢（但会记 `send_failed`）。
