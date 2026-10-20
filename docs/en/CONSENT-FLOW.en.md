# Notice-and-Consent Flow (PIPL Article 23 / Article 39)

> **Language / 语言**：[English](CONSENT-FLOW.en.md) | [简体中文](../CONSENT-FLOW.md)
> English translation of `docs/CONSENT-FLOW.md`; the Simplified Chinese version is authoritative.

Corresponding source: `src/compliance/consent.ts`, `consent-store.ts`, `src/pipeline/forward.ts`, `src/pipeline/notify.ts`.
Applies to: routes declaring `contentOwner: third-party` (forwarding **someone else's** chat content), or overseas links that require separate consent under Article 39.

---

## 1. State machine

```
                    ┌─────────────────────────────────────────────────────────┐
                    │ State 0: consent not given                              │
                    │ Third-party message received → not forwarded;           │
                    │ send the Forwarding Notice                              │
                    └───────────────┬─────────────────────────────────────────┘
                                    │ reply "同意转发" (I consent to forwarding)
                                    ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │ State 1: domestic forwarding consented                  │
                    │ Subsequent messages are forwarded normally              │
                    └───────────────┬─────────────────────────────────────────┘
                                    │ if the target includes Telegram:
                                    │ a separate cross-border consent is also required
                                    ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │ State 2: separate consent for cross-border              │
                    │ transfer obtained                                       │
                    │ Subsequent messages may be forwarded to the             │
                    │ overseas recipient                                      │
                    └───────────────┬─────────────────────────────────────────┘
                                    │ reply "撤回同意" (withdraw consent)
                                    ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │ State 0 (records deleted)                               │
                    └─────────────────────────────────────────────────────────┘
```

Key points:

- **Deny by default**: without valid consent → not a single message is forwarded;
- **Two separate consents**: domestic forwarding consent ≠ cross-border consent, and neither can replace the other;
- **Order is enforced**: while domestic consent has not been obtained, replying "同意出境" (I consent to cross-border transfer) is answered with "please reply 同意转发 first";
- **Instructions are not forwarded**: the consent/withdrawal keyword message itself is **not** forwarded to the target, so the conversation is not polluted.

---

## 2. A realistic conversation example

```
(WeChat private chat; the other party = wxid_colleague, target = QQ 10002)

Other party: See you at the usual place at seven tonight

[not forwarded]  this service → the other party:
  【Forwarding Notice · Your Consent Required】
  Messages you send are not forwarded by default. If you consent, this tool will forward your text messages to the following recipient(s):
    1) Recipient: your secondary QQ account
       Contact: QQ 10002 / you@example.com
       Purpose: personal message syncing for own use, no commercial purpose
       Method: sent as a text message through the EasyBot gateway
       Data categories: text message content, sender platform identifier, send time
       Retention: no message bodies stored; in-memory forwarding only, logs contain no content

  This tool forwards text only; it does not store message bodies and does not log them; after forwarding you may withdraw your consent at any time.
  If you consent, please reply "同意转发" (I consent to forwarding) — as a separate message, taking effect only in this conversation.
  You may reply "撤回同意" (withdraw consent) at any time; after withdrawal this conversation is no longer forwarded.
  (notice version: 2026-10-18.v1)

Other party: 同意转发

[this instruction is not forwarded]  this service → the other party:
  Your "同意转发" (I consent to forwarding) has been recorded. Text messages in this conversation will now be forwarded; reply "撤回同意" to stop at any time.

Other party: What time tomorrow?

[forwarded]  → QQ 10002: What time tomorrow?

Other party: 撤回同意

[not forwarded]  this service → the other party:
  Consent withdrawn. Messages in this conversation will no longer be forwarded. Messages that have already been forwarded cannot be recalled.
```

If that link is also cross-border:

```
this service → the other party:
  【Cross-Border Data Transfer Notice · Your Separate Consent Required】
  One of the recipients above is located overseas (Telegram, whose servers are overseas).
  Providing your personal information to an overseas recipient may constitute a cross-border transfer within the meaning of Article 38 of the Personal Information Protection Law.
  Information about the overseas recipient and the processing:
    1) Recipient: your Telegram bot
       Contact: @your_bot
       Purpose: personal cross-platform syncing for own use
       Method: sent as a text message through the Telegram Bot API
       Data categories: text message content, send time
       Retention: no message bodies stored

  After the transfer, the rights you enjoy under Chapter IV of the Personal Information Protection Law (access, copy, correction, deletion, portability, etc.)
  may be difficult to exercise directly against the overseas recipient. This tool does not complete, on your behalf, the security assessment / standard contract / protection certification required by Article 38.
  If you have been informed of the above risks and separately consent to the cross-border transfer, please reply "同意出境" (it is a consent separate from the one in the previous step).
  You may reply "撤回同意" at any time to withdraw all consents.
```

---

## 3. Keywords and configuration

```yaml
compliance:
  thirdPartyConsent:
    enabled: true
    noticeVersion: "2026-10-18.v1"     # after the notice text changes, old consents become invalid automatically
    persist: true                       # persisted as data/consent.json (metadata only)
    allowCrossBorder: false             # "third-party content + cross-border" is forbidden by default
    consentKeywords: ["同意转发"]
    crossBorderKeywords: ["同意出境"]
    revokeKeywords: ["撤回同意"]
    noticeCooldownMs: 600000            # notice receipt cooldown of 10 minutes, prevents flooding
    ttlDays: 30                         # consent validity period
```

**Matching rule**: an exact whole-message match (strip whitespace, strip common Chinese and English punctuation, lowercase).
It is not a "contains" match — otherwise, whenever the other party quotes the four characters "同意转发" in normal conversation, they would be authorized by mistake.

**Granularity**: consent accumulates per **link (route)**. If the same conversation has several `contentOwner: third-party` routes configured
(for example forwarding to both QQ and Telegram at once), each route needs its own confirmation — because each notice lists only the target recipients of that route,
and one consent must not cover other recipients that were not notified route by route.
`grants[scope].routes[]` in `data/consent.json` records this scope; when an older record has no such field it is interpreted as
"all third-party content routes of that conversation" (clearing it and going through the flow again is recommended).

---

## 4. Storage format and content boundaries

File: `data/consent.json` (when `persist: true`; protected by `.gitignore`)

```json
{
  "version": 1,
  "records": {
    "wechat:wxid_colleague": {
      "scopeKey": "wechat:wxid_colleague",
      "platform": "wechat",
      "conversationId": "wxid_colleague",
      "grants": {
        "domestic": {
          "noticeVersion": "2026-10-18.v1",
          "grantedAt": "2026-10-18T12:00:00.000Z",
          "expiresAt": "2026-11-17T12:00:00.000Z",
          "routes": ["colleague-wx-to-qq"]
        }
      },
      "updatedAt": "2026-10-18T12:00:00.000Z"
    }
  }
}
```

**Present**: conversation identifier, consent scope, notice version, timestamps.
**Absent**: message bodies, message IDs, forwarded content, chat history, send-frequency statistics.

Writes use "temporary file + rename" atomic replacement; a corrupt file **refuses startup** (`CONSENT_STORE_CORRUPT`),
and running in a state where "nobody knows who consented" is not allowed.

---

## 5. Withdrawal and deletion

| Operation | Effect |
|---|---|
| The other party replies "撤回同意" | All authorization records for that conversation are deleted; nothing is forwarded afterwards |
| Delete `data/consent.json` | Clears all consents (equivalent to withdrawing everything); takes effect on restart |
| `ttlDays` expires | Records become invalid automatically (`expiresAt` is checked at decision time) |
| Raise `noticeVersion` | All old consents become invalid; the notice must be sent again and consent obtained again |

> Withdrawal **cannot** recall copies of messages already sent to the other party's platform — the notice text says so plainly, without dressing it up.

---

## 6. Capability boundaries (please read)

| Limitation | Consequence |
|---|---|
| Cannot verify the identity of the replier | Can only establish that "the replying side of that conversation claims to consent"; if the account is used by someone else, the conclusion is unreliable |
| Cannot cover group members | This is why this project **does not support group chat at all** (not "not implemented yet") |
| Cannot verify the recipient's actual processing behaviour | Can only require truthful information to be filled in the configuration |
| Cannot prevent the other party from mis-clicking | Exact keyword matching reduces accidental triggers but cannot eliminate them |
| Notices may be ignored | No reply = never forwarded (the safe direction by default) |

**Why not use `iAgree: true` in the configuration?** That is only the user's promise to themselves, not the data subject's consent.
Article 23 requires "obtaining the individual's separate consent", which must be given by the person themselves. This project uses configuration confirmation only in the
"cross-border + own messages" scenario, because there the data subject is the user themselves.

---

## 7. Local verification flow (no real platform needed)

```powershell
# Terminal A: start the mock gateway
npm run mock

# Terminal B: start with the mock addresses + the consent mechanism enabled + a config with one third-party route
npx tsx src/main.ts --config <your-third-party-config>.yaml

# In the mock console/tests, emit a third-party message → observe: a notice goes only to the source conversation, zero sends to the target conversation
# Emit a message whose text is "同意转发" → observe: a record appears in consent.json and the instruction is not forwarded
# Emit a normal message → observe: a forwarding request for the target conversation appears in mock.sent
```

The corresponding automated assertions are in `test/consent.spec.ts`.
