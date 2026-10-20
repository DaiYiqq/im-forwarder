# Routing Matrix Design and Runtime Semantics

> **Language / 语言**：[English](ROUTING.en.md) | [简体中文](../ROUTING.md)
> English translation of `docs/ROUTING.md`; the Simplified Chinese version is authoritative.

This document explains the semantics of the `routes:` configuration, the compile-time rules, the runtime policy chain, and loop protection.
Corresponding source: `src/routing/matrix.ts`, `src/routing/resolve.ts`, `src/routing/policy.ts`, `src/pipeline/loop-guard.ts`.

---

## 1. Model: a set of directed edges, not "pairwise hard-coding"

```
WeChat private chat A ──┐                                     ┌──▶ QQ private chat X
                        ├── routing matrix (directed edges) ──┤
QQ private chat X ──────┘                                     └──▶ WeChat private chat A
```

- Node = `platform:conversationId:chatType` (for example `wechat:wxid_abc:private`)
- Edge = one `routes[]` item: `from` → `to[]` (one source can fan out to multiple targets, at most 8)
- Index = the `source key → route list` built at compile time; O(1) lookup at runtime
- There is **no** built-in "platform to platform" special case. Adding a WeChat→Telegram route goes through exactly the same code as adding a WeChat→QQ route.

---

## 2. Configuration fields

```yaml
routes:
  - id: wx-private-to-qq          # required, globally unique
    group: self-wx-qq             # required, the same logical link; loop protection and cycle detection are decided per group
    contentOwner: self            # required: self | third-party (no default)
    from:
      platform: wechat
      conversationId: "wxid_xxx"
      chatType: private
    to:
      - platform: qq
        conversationId: "10001"
        chatType: private
        # Required only when contentOwner=third-party:
        receiver:
          name: "receiver name"
          contact: "contact details"
          purpose: "processing purpose"
          method: "processing method"
          dataCategories: ["data category 1", "data category 2"]
          retention: "retention period"
```

| Field | Constraint | Why |
|---|---|---|
| `id` | Unique | Log/audit identification |
| `group` | `contentOwner` must be consistent within the same group; a cycle must not cross groups | Content fingerprints are scoped per group, so a cross-group cycle would defeat the protection |
| `contentOwner` | **No default** | Whether someone else's content is being forwarded is a question of fact that the program cannot determine; it must be declared by a human |
| `chatType` | Must be `private` (all platforms) | A group chat cannot obtain consent from each member (PIPL Article 23) |
| `to[].receiver` | Six items required for third-party | Article 23 notice elements; startup is refused when any item is missing |

---

## 3. Compile-time rules (violation → the process refuses to start, exit 78)

| Rule | Error code |
|---|---|
| WeChat source/target is a group chat | `WECHAT_GROUP_SOURCE_FORBIDDEN` / `WECHAT_GROUP_TARGET_FORBIDDEN` |
| Group chat on a non-WeChat platform | `GROUP_CHAT_UNSUPPORTED` |
| Self-loop (`from == to`) | `ROUTE_SELF_LOOP` |
| Duplicate route id | `DUPLICATE_ROUTE_ID` |
| Duplicate edge (same from→to) | `DUPLICATE_EDGE` |
| Content ownership conflict within a group | `GROUP_CONTENT_OWNER_CONFLICT` |
| Cycle that crosses groups | `CYCLE_ACROSS_GROUPS` |
| A cycle exists but `loopGuard.enabled=false` | `LOOP_GUARD_REQUIRED` |
| Target includes telegram but the cross-border gate is not open | `CROSS_BORDER_GATE_CLOSED` / `CROSS_BORDER_ACK_INCOMPLETE` |
| third-party but the consent mechanism is not enabled | `THIRD_PARTY_CONSENT_DISABLED` |
| third-party target is missing notice elements | `THIRD_PARTY_NOTICE_MISSING` |
| third-party + cross-border and `allowCrossBorder=false` | `THIRD_PARTY_CROSS_BORDER_FORBIDDEN` |
| `gateway.baseUrl/eventsUrl` points at an official platform domain | `DIRECT_PLATFORM_ENDPOINT` |

> Design principle: **conflicts are not resolved automatically**. When two routes contradict each other, we would rather fail startup so that you can see the configuration plainly than "guess a combination that happens to run".

---

## 4. Runtime policy chain

The order is fixed, and any uncertainty resolves towards "do not forward":

| Step | Condition | Resulting status |
|---|---|---|
| P0 | `senderIsSelf` | `skipped_self` (debug log) |
| P0 | `senderIsBot` | `skipped_bot` (prevents bots from kicking each other) |
| P1 | `chatType !== private` (any platform) | `skipped_group_forbidden` |
| P2 | No route matched | `skipped_no_route` (debug log) |
| P3 | Echoed messageId matched and `hop+1 > maxHops` | `skipped_loop_suspected` |
| P4 | `kind !== "text"` | receipt sent to the source conversation → `skipped_unsupported_kind` |
| P5 | Cross-border edge and the gate is not open (defence in depth) | `blocked_cross_border` |
| P6 | Short-lived content fingerprint matched | `skipped_loop_suspected` |
| P7 | third-party and consent is missing | notice sent → `blocked_consent_pending` |
| P8 | Everything else | `forwarded` / `send_failed` |

One source conversation can match several routes at the same time (fan-out). Each route is evaluated independently; they do not affect one another.

---

## 5. Loop protection (three layers)

### Layer 1: echoed messageId (primary)

After a successful send, record the `messageId` returned by the target side in an in-memory table:
`(targetPlatform, targetConversationId, messageId) → (group, hop)`.
If the gateway pushes that message back as a "new inbound message", it is recognized directly as our own echo.

### Layer 2: short-lived content fingerprint (fallback)

When the adapter does not return a `messageId`, compute an HMAC-SHA256 over the text with a **per-process random salt**, and compare it against text flowing back within the same group inside the `fingerprintWindowMs` window (default 20s).
Fingerprints live only in memory; they are never written to disk, never printed, and vanish when the process exits.

### Layer 3: hop budget

- `maxHops: 1` (default): a message this service has forwarded is **never forwarded a second time** — any echo is discarded;
- `maxHops: 2`: the chain is allowed one more hop (A→B→C); anything after the second hop is still discarded.
- The hop count is attached to the echo record, so it is **exact only when the gateway returns a messageId**; when no ID is returned, the fingerprint layer is the fallback.

### Typical scenario

```
WeChat ──(forward, messageId=mock-1)──▶ QQ
QQ     ──(gateway pushes back messageId=mock-1)──▶ this service
                                                   ├─ maxHops=1 → hop+1=2 > 1 → drop ✅
                                                   └─ maxHops=2 → allow one more forward, hop=2
```

---

## 6. Common failures and what they mean

| Symptom | Meaning | Action |
|---|---|---|
| Exits 78 immediately on startup, reporting `LOOP_GUARD_REQUIRED` | Bidirectional routes exist but loop protection is disabled | Restore `loopGuard.enabled=true` |
| Every message lands in `skipped_no_route` | `conversationId` does not match the platform's actual conversation ID | Check the gateway's event log (note: this service does not print conversation IDs, so check on the gateway side) |
| `blocked_consent_pending` keeps appearing | The other party has not replied with the consent keyword | Normal; it recovers automatically once the other party replies "同意转发" (I consent to forwarding) |
| `send_failed` + `gateway_http_4xx` | Wrong target conversation ID, the bot is not in the conversation, or gateway authentication failed | Check the gateway; this is not a problem in this service |
| Forwarding succeeds but the other party immediately receives the message again | The echo was not recognized | Confirm whether the gateway returns a `messageId`; lowering `fingerprintWindowMs` does not solve it — fix the gateway instead |
| `ws_unmapped_event` appears in volume | `fieldMap` does not match the gateway's fields | Change `gateway.fieldMap`, see [GATEWAY-CONTRACT.en.md](GATEWAY-CONTRACT.en.md) |

---

## 7. Design trade-offs (why it is done this way)

1. **Explicit bidirectional edges instead of `bidirectional: true` sugar**: each edge can be reviewed and disabled on its own, which makes audits self-evident.
2. **Group chat is not supported at all, rather than "WeChat only"**: consent cannot be obtained from each member of a group; doing it halfway is more dangerous than not doing it.
3. **"Send to everyone" is not supported**: fan-out targets must be written into the configuration one by one, which avoids accidentally spreading private chat content.
4. **Failed business errors are not retried automatically**: retrying 4xx only amplifies the error (the gateway layer retries only network/5xx/429).
5. **No message queueing**: persisting a queue to disk = persisting message bodies, which conflicts with Requirement 8. The cost is that a failed send is lost (but it is recorded as `send_failed`).
