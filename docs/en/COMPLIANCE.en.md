# COMPLIANCE.md · Compliance design and clause-by-clause mapping

> **Language / 语言**：[English](COMPLIANCE.en.md) | [简体中文](../../COMPLIANCE.md)
> This is the English translation of `COMPLIANCE.md`. The Simplified Chinese version is authoritative;
> if they conflict, the Chinese text prevails.

> **Reading notes**
> - This document is not legal advice, and it does not constitute a compliance conclusion for any specific use case. For any judgment involving the processing of personal information, consult a practising lawyer.
> - This document is addressed to **the person who deploys and runs this service** (hereafter "the user"). Under the *Personal Information Protection Law* (PIPL), the user determines the purpose and the means of processing and is therefore a **personal information processor**; the author of this project takes part in no actual processing.
> - This document describes **what this project's code does and does not do**. The user's own lawfulness (whether consent has been obtained, whether cross-border procedures have been completed, whether network access is lawful) is outside the author's control.
> - Corresponding versions: code `0.1.0`, risk-notice version `2026-10-18.v1`.
>   Platform terms (WeChat iLink / ClawBot, QQ, Telegram) may be updated at any time; **the platforms' latest official terms prevail before use**.

---

## 0. Summary of conclusions

| # | Conclusion | One-line basis |
|---|---|---|
| 1 | This repository contains **no** WeChat login / protocol reverse-engineering / hook code whatsoever | All WeChat capability is provided by the EasyBot gateway through the official iLink (ClawBot) channel; `src/gateway/contract.ts` is the only protocol boundary |
| 2 | This repository **does not process** WeChat group chat messages | Compile-time `WECHAT_GROUP_SOURCE_FORBIDDEN` + runtime `skipped_group_forbidden`, and **no configuration switch** can open it |
| 3 | This repository has **no** MTProto / Telethon / Pyrogram / userbot code path | Dependencies are only `ws/yaml/zod`; outbound traffic may only be HTTP calls in Bot API shape; `scripts/compliance-scan.mjs` enforces this in CI |
| 4 | Telegram cross-border transfer is **off by default**, and **refuses to start** if any single confirmation is missing | `defaultComplianceSettings()` is all-off; `runPreflight()` returns `CROSS_BORDER_GATE_CLOSED` → exit 78 |
| 5 | Forwarding other people's content **does not exist by default** and requires a genuine "notice → separate consent" flow | `contentOwner` has no default value; mechanism not enabled → `THIRD_PARTY_CONSENT_DISABLED`; no forwarding before consent |
| 6 | Logs are **physically incapable** of containing message content | `LOG_FIELD_WHITELIST` allow-list + value-length replacement; canary assertion in `test/redaction.spec.ts` |
| 7 | **No chat content is persisted** | No database, no queue, no on-disk cache; content exists only within a single call stack |
| 8 | This project **cannot** substitute for the cross-border procedures required by PIPL Articles 38/55 | The code only implements "off by default + audit trail + notice"; it never claims compliance |

---

## 1. Processing activities and roles

### 1.1 Data flow

```
Inbound event (gateway WS)
  └─▶ Normalization (src/gateway/mapping.ts, field-by-field validation of untrusted input)
        └─▶ Policy chain (src/routing/policy.ts)
              ├─ Drop: self / bot / group chat / no route / echo / no consent
              └─ Pass: text transform (src/pipeline/transform.ts, pure in-memory)
                    └─▶ Send (src/gateway/client.ts → gateway REST)
```

The lifetime of the message content = one `Forwarder.handle()` call. After the method returns, in theory only a non-reversible HMAC fingerprint remains (memory only).

### 1.2 Roles and deployment forms (**this section directly affects your obligations**)

| Deployment form | Role relationship | What you need to watch |
|---|---|---|
| The EasyBot gateway runs on **your own machine / LAN** and only you can access it | The gateway is your processing tool (in effect part of the software); you are the sole processor | The rest of this document describes this form |
| The gateway is **hosted / managed by a third party** (cloud provider, friend, paid service) | This may constitute **entrusted processing** under PIPL Article 21 (an entrusted-processing contract and supervision are required), or **provision to another processor** under Article 23 (notice + separate consent required) | This project cannot sign contracts on your behalf; judge for yourself and stop using it where necessary |
| You deploy this service on a **cloud server** where the provider can reach the disk/memory | The cloud provider is normally an entrusted processor | Confirm the data-processing terms of the cloud service agreement; this project writes nothing to disk, which lowers but does not eliminate the risk |

> In other words: **the same program under a different deployment model can turn a compliance obligation from "none" into "existing".**
> This project can guarantee only that the code side does not overstep; it cannot guarantee that the deployment side is compliant.

---

## 2. PIPL, article by article

Status legend: **Implemented** = enforced by code; **User responsibility** = the code can only notify / leave an audit trail and cannot discharge the obligation for you; **Not applicable** = this project has no corresponding processing activity.

### 2.1 Article 6 (clear purpose, minimum necessity)

| Item | Content |
|---|---|
| Requirement | Personal information shall be processed for a clear and reasonable purpose, directly related to that processing purpose, and by means that have the least impact on personal rights and interests; collection shall be limited to the minimum scope required to achieve the processing purpose. |
| What this project implements | ① Only one type is processed: "text messages"; ② only the **specific conversations** explicitly listed in the routing matrix are processed (no account-level subscription, no address-book reading); ③ no full-text search, no profiling, no statistical aggregation; ④ group chats are not supported at all (avoiding indiscriminate collection of group members' information); ⑤ no media download. |
| Code location | `src/types.ts › SUPPORTED_KINDS`; `src/routing/resolve.ts` (exact per-conversation matching); `src/config/schema.ts › routeSchema` |
| Status | Implemented (minimization on the code side; whether the conversation scope you choose is "minimal" is your responsibility) |

### 2.2 Article 13 (lawful basis for processing)

| Item | Content |
|---|---|
| Requirement | Processing personal information shall obtain the individual's consent, or fall within a statutory circumstance such as being necessary for the conclusion or performance of a contract, or the performance of statutory duties. |
| What this project implements | ① You determine for yourself which lawful basis applies; ② where **another person's** content is involved, the code enforces the Article 23 notice-and-consent flow; ③ where **cross-border transfer** is involved, the code mandates your explicit confirmation + the Article 39 separate consent. |
| Code location | `src/compliance/consent.ts`, `src/pipeline/forward.ts › handleConsentCommand`, `src/compliance/preflight.ts` |
| Status | User responsibility (the code provides the mechanism; it does not determine lawfulness) |

### 2.3 Article 17 (notice before processing)

| Item | Content |
|---|---|
| Requirement | Before processing personal information, the processor shall, in a conspicuous manner and in clear, easy-to-understand language, truthfully, accurately and completely inform the individual of: the name and contact details of the processor, the purpose and means of processing, the categories of personal information and the retention period, and the manner and procedure by which the individual may exercise their rights. |
| What this project implements | ① The project itself does not actively collect information, so there is no "registration / collection" notice step; ② in **another person's content** scenarios, notice is delivered through a private-chat receipt that covers each Article 23 element (see 2.4); ③ the manner of exercising rights is stated in the notice as "reply to withdraw consent". |
| Code location | `src/pipeline/notify.ts › domesticConsentNotice`, `crossBorderConsentNotice` |
| Status | Implemented (covers the forwarding scenarios only; your notice obligations in any other segment are outside this project's scope) |

### 2.4 Article 23 (provision to another processor → notice + separate consent) ★

| Item | Content |
|---|---|
| Requirement | Where personal information processed by a personal information processor is provided to another personal information processor, the individual shall be informed of **the recipient's name, contact details, processing purpose, processing means and categories of personal information**, and **separate consent** shall be obtained; the recipient shall process the information within that scope, and shall obtain fresh consent if it changes the purpose or means. |
| What this project implements | ① `contentOwner: "third-party"` is the **only** entry point that can forward another person's content, and it **has no default value** (it must be filled in by hand); ② when that field is present, `runPreflight` mandates `thirdPartyConsent.enabled=true`; ③ every target must supply all six fields of `receiver.{name, contact, purpose, method, dataCategories, retention}`; missing any one → **refuses to start**; ④ the first message is **not forwarded** — a notice is sent first; ⑤ forwarding begins only after the other party replies with the keyword (default 「同意转发」, "consent to forward"); ⑥ consent is recorded at **conversation + route** granularity (`grants[scope].routes[]`): if one conversation has several third-party routes configured, each of them must be confirmed separately, which prevents "one consent authorizes every recipient"; ⑦ withdrawal is possible at any time (withdrawal applies to the conversation as a whole); ⑧ records contain metadata only, never content. |
| Code location | Determination: `src/compliance/gates.ts › isThirdPartyRoute`, `src/compliance/preflight.ts` (`THIRD_PARTY_CONSENT_DISABLED` / `THIRD_PARTY_NOTICE_MISSING`)<br>Flow: `src/routing/policy.ts` (step 7), `src/pipeline/forward.ts › handleNotice`, `handleConsentCommand`<br>Wording: `src/pipeline/notify.ts`<br>Storage: `src/compliance/consent-store.ts` |
| Status | Implemented (off by default; see the **capability boundaries** in section 6 and do not overestimate it) |
| Residual risk | Cannot verify that the replier is the data subject; cannot cover group members (hence no group chat support); already-forwarded content cannot be recalled. |

### 2.5 Article 38 (conditions for providing personal information abroad) ★

| Item | Content |
|---|---|
| Requirement | Where personal information must be provided abroad because of business needs or other genuine needs, one of the following conditions shall be met: (1) passing a security assessment organized by the national cyberspace administration under Article 40; (2) obtaining personal information protection certification from a professional institution; (3) concluding a contract with the overseas recipient using the standard contract formulated by the cyberspace administration; (4) other conditions prescribed by laws, administrative regulations or the cyberspace administration. |
| What this project implements | ① **0 cross-border routes by default**; ② if a cross-border edge exists (target platform = telegram) while the gate is not open → the process exits 78; ③ the gate has four elements: `enabled` + `operator` (signature) + `acknowledgedAt` (ISO time) + `selfMessagesOnlyConfirmed` (own messages only); ④ a change of `riskNoticeVersion` automatically invalidates earlier confirmations; ⑤ the full cross-border risk notice is printed at startup. |
| Code location | `src/compliance/gates.ts › isCrossBorderEdge`, `evaluateCrossBorderGate`<br>`src/compliance/cross-border.ts › CROSS_BORDER_RISK_NOTICE`, `crossBorderStartupBlocker`<br>`src/compliance/preflight.ts` (`CROSS_BORDER_GATE_CLOSED` / `CROSS_BORDER_ACK_INCOMPLETE`)<br>`src/config/schema.ts › defaultComplianceSettings` |
| Status | **The code only implements a gate; it cannot satisfy the substantive conditions of Article 38** — the security assessment / certification / standard contract must all be handled by you personally. |
| Residual risk | The user may have ticked the switch without having completed the statutory procedure. The code cannot verify this, and it does not pretend to. |

### 2.6 Article 39 (cross-border notice + separate consent) ★

| Item | Content |
|---|---|
| Requirement | Where personal information is provided abroad, the individual shall be informed of **the name and contact details of the overseas recipient, the processing purpose, the processing means, the categories of personal information**, and **the manner and procedure for exercising the rights under this Law against the overseas recipient**, and the individual's **separate consent** shall be obtained. |
| What this project implements | ① A cross-border route requires, **in addition to** the "domestic forwarding consent", a separate independent consent (default keyword 「同意出境」, "consent to cross-border transfer"; together with 「同意转发」 these are two independent consent actions); ② the notice text explicitly states the overseas recipient's name / contact details / purpose / means / categories, and warns that "after the cross-border transfer, rights may be difficult to exercise directly against the overseas recipient"; ③ cross-border consent cannot be given without domestic consent first (the order is enforced). |
| Code location | `src/pipeline/notify.ts › crossBorderConsentNotice`<br>`src/compliance/consent.ts › requiredScopes` (`domestic` + `cross-border`)<br>`src/pipeline/forward.ts › handleConsentCommand` (the `grant-cross-border` branch) |
| Status | The "two independent consents + notice elements" are implemented and constitute a **mechanism**; whether "separate consent" holds still depends on your actual scenario and the quality of the notice. |
| Special note | If what is forwarded are **your own** messages, you are the data subject, and `selfMessagesOnlyConfirmed` at the configuration level is your own self-confirmation; if **another person's** content is forwarded, that person must reply with the cross-border consent themselves — and this project forbids the "third-party content + cross-border transfer" combination by default (`allowCrossBorder=false`), so you must enable it separately and bear the judgment responsibility yourself. |

### 2.7 Article 47 (right to deletion)

| Item | Content |
|---|---|
| Requirement | Where the processing purpose has been achieved, cannot be achieved, or is no longer necessary, the processor shall proactively delete the information; where an individual requests deletion, it shall be deleted. |
| What this project implements | ① No content is stored, so "deleting message content" does not exist architecturally; ② consent metadata can be deleted immediately for that conversation via "withdraw consent"; ③ deleting `data/consent.json` clears all consent records (equivalent to withdrawing everything). |
| Code location | `src/compliance/consent.ts › revoke`, `src/compliance/consent-store.ts › remove` |
| Status | Implemented (for the portion of metadata this project stores); **copies of messages already forwarded to the other platform are outside this project's control**. |

### 2.8 Article 51 (security measures)

| Item | Content |
|---|---|
| Requirement | Adopt organizational and technical measures to guarantee security: classification management, encryption / de-identification, access control, training, contingency plans, etc. |
| What this project implements | ① Least privilege: holds no platform credentials, only the gateway token, read solely from an environment variable; ② credentials are forbidden in the configuration file (dangerous-key scan); ③ log de-identification (no conversation IDs, no content); ④ an extremely small dependency surface (3 runtime dependencies) + CI static scan; ⑤ consent records are written atomically and refuse to start when corrupt; ⑥ features that would enlarge the attack surface (group chats / media / AI) are simply not implemented. |
| Code location | `src/config/load.ts › findForbiddenConfigKeys`, `src/observability/logger.ts`, `src/compliance/consent-store.ts › flush`, `scripts/compliance-scan.mjs`, `.github/workflows/ci.yml` |
| Status | Implemented on the code side; **policies, training, contingency plans and access-permission management are the user's responsibility** |

### 2.9 Articles 55 and 56 (personal information protection impact assessment before cross-border transfer)

| Item | Content |
|---|---|
| Requirement | Before providing personal information abroad, a personal information protection impact assessment (PIPIA) shall be conducted in advance and the processing shall be recorded; the assessment report and the processing records shall be **kept for at least three years**. |
| What this project implements | **Not implemented, and impossible to implement.** The assessment depends on your specific circumstances (recipient, necessity, impact on individual rights and interests, security risk). |
| Code location | —— (explicitly not applicable: this project generates no PIPIA report and keeps no processing records) |
| Status | User responsibility |
| Note | If you enable any cross-border route, complete a PIPIA first and keep the report. The `operator` / `acknowledgedAt` in the code are an audit trail only — **not** an assessment report. |

### 2.10 Sensitive personal information (Articles 28 to 30)

| Item | Content |
|---|---|
| Requirement | Processing sensitive personal information (biometrics, religious belief, specified identity, medical health, financial accounts, whereabouts and movement trajectories, etc.) requires a specific purpose, sufficient necessity, strict protection measures and separate consent. |
| What this project implements | Conceptually it collects no sensitive information; **however**: the **content of a text message may itself contain sensitive information entered by the user** (for example, someone sending an ID-card number). This cannot be technically detected and blocked, and this project deliberately **does not** perform content recognition (that would introduce a new processing activity). |
| Status | Not applicable (this project does not actively process) + the user's duty of care |
| Recommendation | Do not transmit ID-card numbers, bank cards, medical information and the like over the forwarding chain; if such a need genuinely exists, use a dedicated compliance system instead. |

---

## 3. Platform terms

### 3.1 WeChat iLink (ClawBot) — official channel, non-commercial licence, private chat only

| Item | Content |
|---|---|
| Nature of the channel | Tencent's officially opened iLink (ClawBot) capability, with the access domain `ilinkai.weixin.qq.com`; login and authorization of the bot / channel are completed **on the gateway side** following the official procedure (QR code / credentials). |
| Licence restriction | The capability is granted under a **non-commercial** licence. This project's LICENSE explicitly forbids charging, paid hosting and resale; the first paragraph of the README prominently states "must not be used in commercial scenarios, paid services or paid hosting". |
| Private-chat restriction | On the WeChat side **only private chat messages are processed**. This project rejects group-chat routes at compile time (`WECHAT_GROUP_SOURCE_FORBIDDEN` / `WECHAT_GROUP_TARGET_FORBIDDEN`), rejects them again at runtime (`skipped_group_forbidden`), and **no switch whatsoever** can open them. |
| Capabilities not used | No friend-directory calls, no message recall, no history queries, no proactive group creation, no media sending. These API calls do not exist in the code. |
| Code evidence | ① No WeChat client / SDK / protocol code anywhere in the repository; ② `src/gateway/contract.ts` contains only the unified REST/WS contract; ③ preflight's `DIRECT_PLATFORM_ENDPOINT` rejects a `baseUrl` pointing at `ilinkai.weixin.qq.com` / `weixin.qq.com` / `api.telegram.org` / `telegram.org` (hostnames are first lower-cased and normalized by stripping trailing dots, so equivalent forms such as `ilinkai.weixin.qq.com.` are rejected as well); ④ `scripts/compliance-scan.mjs` scans for forbidden dependencies and keywords in CI. **Note: this blocklist is an auxiliary defence intended to reduce mis-connection; it is not a security boundary.** The real guarantee is that no platform SDK and no login capability exists in the code at all (see docs/AUDIT.md). |
| Status | Implemented |
| Note | The terms described above are subject to Tencent's latest official documentation; this project cannot guarantee that they remain unchanged. If the official authorization scope changes, users should stop using this project and update it accordingly. |

### 3.2 QQ / NapCat — unofficial channel; account-ban risk borne by the user

| Item | Content |
|---|---|
| Nature | **NapCat is not an official QQ bot channel.** It logs into a personal QQ account through unofficial means and converts it to the OneBot 11 protocol. Using it carries risks: login verification (device lock / SMS / face recognition), frequent disconnections, risk-control restrictions and **account bans**. |
| Requirements of this project | ① Written explicitly as risk warning item 3 in the README; ② the startup banner always prints "NON-OFFICIAL · a throwaway account is mandatory"; ③ this project **contains** no QQ login code and does not help circumvent verification; ④ it implements no risk-control evasion whatsoever (no reconnect-storm control, no protocol camouflage; the gateway client only performs limited retries on network errors, which is unrelated to evasion). |
| MUST | **A dedicated throwaway account is mandatory; a main account is strictly forbidden.** This is not a recommendation but a precondition for using this project. |
| Code location | `src/compliance/preflight.ts › banner`, `README.md` risk warning item 3 |
| Status | Risk declared; the risk cannot be eliminated |
| Residual risk | NapCat itself may retain messages / logs / databases locally. **This project cannot control storage on the gateway side**; please check NapCat's data directory and logging configuration yourself. |

### 3.3 Telegram — official Bot API only, userbots explicitly excluded

| Item | Content |
|---|---|
| Chosen approach | Only a **bot created via BotFather + the official Bot API** (called by the gateway). |
| Permission boundary | A bot can only receive: ① messages that users actively send to it; ② messages visible under Bot API rules in groups it has been added to. **This project does not attempt to read any user's private chat history or other people's conversations**, and has no such capability. |
| Why userbots are excluded | ① **Terms**: logging into an account under a personal identity through unofficial clients / automation violates Telegram's restrictions on account automation and unofficial clients; ② **permissions**: a userbot has full conversation access to that personal account, which amounts to introducing the ability to "read other people's private chats" into the system and directly conflicts with PIPL's principle of minimum necessity; ③ **credentials**: a userbot must store the `api_hash` / `session` string, a leak of which equals full account takeover. |
| Code evidence | Dependencies are only `ws/yaml/zod`; `compliance-scan` lists `telethon\|pyrogram\|mtproto\|tdlib\|api_hash\|session_string\|userbot` as forbidden words; the configuration loader rejects these keys. |
| Status | Implemented |
| Cross-border risk | See section 5. |

---

## 4. Scenarios this project explicitly does "not involve"

Each item below is a **considered conclusion**, not an omission. Basis: the corresponding capability does not exist in the code, and some scenarios are actively rejected.

| Scenario | Conclusion | Basis |
|---|---|---|
| Receiving / sending WeChat group chat messages | **Not applicable, and forcibly rejected** | Two-layer rejection by `checkRouteShape` + `decideAll`; no switch |
| Group chats on any platform | **Not applicable, and forcibly rejected** | Consent cannot be obtained from each member individually inside a group (Article 23), so group chats are unsupported as a whole |
| WeChat friend directory / address book | Not applicable | No related API calls |
| Message recall | Not applicable | No related API calls |
| History query / look-back | Not applicable | The gateway only pushes real-time events; this service requests no history |
| Images / voice / video / files / emoji | **Not applicable, explicitly skipped** | `SUPPORTED_KINDS = ["text"]`; when skipping, a receipt is sent to the source conversation, never a silent drop |
| Message content persistence | Not applicable | No database / queue / cache; `data/` holds consent metadata only |
| Address-book expansion / multicast broadcasting | Not applicable | The routing matrix is "specified conversation → specified conversation"; there is no "send to everyone" |
| User profiling / automated decision-making / statistics | Not applicable | No aggregation or analysis logic of any kind |
| Content moderation / AI processing | Not applicable | No content recognition, no rewriting, no summarization |
| Circumvention network schemes (proxy / tunnel) | **Not applicable, and explicitly forbidden** | No such code in the repository; the README states that none is provided or recommended |
| Paid / commercial hosting | **Not applicable, and forbidden by the licence** | LICENSE (MIT + Commons Clause) |

---

## 5. Cross-border data transfer (Articles 38, 39)

### 5.1 Legal characterization

> Telegram's servers are located outside China. **Forwarding messages from WeChat/QQ to Telegram may constitute "providing personal information abroad" within the meaning of Article 38 of PIPL.**

Decision rule (as implemented in code): **a route whose target platform is `telegram` = a cross-border edge** (`isCrossBorderEdge`).
The reverse direction (Telegram → WeChat/QQ) is "inbound"; Article 38 does not apply to it, but the territorial applicability of Article 3, the minimum necessity of Article 6 and the notice-and-consent of Article 23 still apply. This project's corresponding behaviour is that inbound routes are likewise absent from the example configuration by default and still have to satisfy the third-party content consent mechanism.

### 5.2 How the code turns "off by default" into a hard constraint

```yaml
compliance:
  telegramCrossBorder:
    enabled: false                     # ① defaults to false
    operator: null                     # ② signature of the person who enables it (traceable)
    acknowledgedAt: null               # ③ ISO8601 confirmation time
    selfMessagesOnlyConfirmed: false   # ④ confirmation that only own messages are forwarded
    riskNoticeVersion: "2026-10-18.v1" # ⑤ notice version; changing it invalidates old confirmations
```

- if any single item is not satisfied → `evaluateCrossBorderGate()` returns `open: false`;
- if a cross-border edge exists while the gate is not open → `runPreflight()` produces `CROSS_BORDER_GATE_CLOSED` / `CROSS_BORDER_ACK_INCOMPLETE`;
- → `main.ts` prints the complete remediation advice and **`exit 78`**, establishing no connection at all;
- the runtime policy chain has one more backstop (`blocked_cross_border`), so that breaking the code cannot bypass the compile-time check.

### 5.3 Article 39 notice elements → where they land in the code

| Article 39 element | Landing point |
|---|---|
| Name of the overseas recipient | `receiver.name` (enforced by configuration) / `crossBorderConsentNotice` from line 5 |
| Contact details of the overseas recipient | `receiver.contact` |
| Processing purpose | `receiver.purpose` |
| Processing means | `receiver.method` |
| Categories of personal information | `receiver.dataCategories` |
| Manner and procedure for exercising rights against the overseas recipient | the "after the cross-border transfer … may be difficult to exercise directly" warning in `crossBorderConsentNotice` + the withdrawal instruction |
| Separate consent | an independent keyword (default 「同意出境」) + an independent `grant` record (`ConsentScope = "cross-border"`) |

### 5.4 What you must still do yourself (the code cannot substitute)

1. Complete one of the three Article 38 pathways (security assessment / protection certification / standard contract), or confirm that an exemption applies;
2. Complete the Article 55 PIPIA and keep the report for at least three years (Article 56);
3. Confirm that the actual identity and contact details of the overseas recipient (the Telegram bot / its operator) are genuine and usable;
4. Judge whether "only own messages are forwarded" is true — the code cannot verify it;
5. Ensure that your network access method is lawful and compliant (README risk warning item 6).

---

## 6. How the notice-and-consent mechanism (Article 23) is implemented, and its capability boundaries

### 6.1 Trigger and flow

```
Another person's message arrives
  ├─ Does it hit a third-party route?
  │   No → normal policy chain
  │   Yes → Is there already a valid consent? ── Yes → forward
  │                                            └─ No → send notice (no forwarding) → wait for the reply
  │                                                  ├─ 「同意转发」 → record domestic consent (metadata) → forward from the next message on
  │                                                  ├─ 「同意出境」 → requires domestic consent first → record cross-border
  │                                                  └─ 「撤回同意」 → delete the record → stop immediately
```

### 6.2 What is stored (`data/consent.json`)

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
          "grantedAt": "...",
          "expiresAt": "...",
          "routes": ["colleague-wx-to-qq"]
        }
      },
      "updatedAt": "..."
    }
  }
}
```

**Metadata only.** No message content, no message IDs, no forwarded content, no chat history.
`routes` records which routes that consent covers, guaranteeing that "the scope of the notice = the scope actually authorized".
The purpose of storage is "to be able to prove that consent occurred" — the only form in which Article 23 can be evidenced in a dispute.

> Compatibility note: records written by earlier versions have no `routes` field and are interpreted on read as
> "all third-party content routes of that conversation" (fail-open). If your existing records come from an older
> version, it is recommended to clear them and go through the notice flow again.

### 6.3 Capability boundaries (must be honest)

| Limitation | Explanation |
|---|---|
| Identity cannot be verified | The record can only prove that "the replying party in that private conversation claims to consent"; it cannot prove that they are the data subject (the account may be used by someone else) |
| Group members cannot be covered | Hence this project **does not support group chats at all** |
| Forwarded content cannot be recalled | Withdrawal affects subsequent messages only |
| The notice may be ignored | If the other party does not reply, nothing is ever forwarded (default deny — the right direction) |
| The recipient's actual processing cannot be verified | The configuration can only be required to contain truthful information; whether the recipient processes within the notified scope is outside this project's control |
| **Consent records can be tampered with on this machine** | `data/consent.json` is plain JSON with **no signature / HMAC / remote attestation**. Anyone able to write that file can forge "consent". This tool targets single-machine personal use, so consent records carry "internal credibility" only; if non-repudiation is required, introduce signatures or third-party attestation |
| **Eligibility to consent depends on a gateway flag** | "Who can trigger consent" depends on the `senderIsSelf` / `senderIsBot` reported by the gateway; when the field is missing it is treated as `false`. If the gateway fails to report the bot flag, other bots may write consent on someone's behalf (`docs/AUDIT.md` F4) |
| **`contentOwner` is a self-declared field** | The user can label "another person's conversation" as `self` and thereby bypass the consent mechanism entirely. The program cannot determine conversation ownership — this is the fundamental boundary of the design |
| **Group-chat determination depends on the gateway** | The runtime hard gate relies on the `chatType` and `fieldMap` pushed by the gateway; if the gateway misreports a group chat as `private`, the hard gate fails. The gateway contract must guarantee that this field is trustworthy |

> **Why not simply tick an `iAgree: true` in the configuration file?**
> That is only a declaration the user makes about themselves — a self-commitment by the processor — and **not** the data subject's consent.
> Article 23 requires "obtaining the individual's separate consent", which must be given by the data subject themselves (in the conversation).
> This project uses configuration confirmation only in the "cross-border transfer + own messages" scenario, because there the data subject is the user themselves.

---

## 7. Logging, retention and auditability

| Item | Implementation |
|---|---|
| Log fields | `ts / level / event / routeId / sourcePlatform / targetPlatform / status / errorCode / latencyMs / kind / scope / count / attempt` |
| Not recorded | message content, conversation IDs, user nicknames, media content, raw payloads, gateway response bodies |
| Leak-prevention design | ① type layer: `LogFields` permits allow-listed keys only; ② runtime layer: values are picked against the allow-list before writing; ③ value scrubbing: values longer than 120 characters are replaced by `[omitted:N]` (**no prefix is retained**, because the prefix may itself contain content); ④ control characters are stripped |
| Verifiability | `test/redaction.spec.ts` injects canary text and asserts that no log line contains it; it also asserts that the key set ⊆ the allow-list |
| Content retention | None (no database / no queue / no on-disk cache / no crash-dump logic) |
| Consent metadata retention | 30 days by default (`ttlDays`), then expires automatically; the file is protected by `.gitignore` |
| In-memory data | Only HMAC fingerprints (random salt per process) and a short-lived deduplication table; both vanish when the process exits |

---

## 8. Acceptance self-check (corresponding to the client's 8 checks)

| # | Check | Conclusion | Evidence |
|---|---|---|---|
| 1 | Is there any WeChat login code that bypasses the official iLink? | **No** | No WeChat SDK / login code anywhere in the repository; `src/gateway/contract.ts` is the only protocol boundary; `preflight` rejects direct connections to platform domains (hostnames are normalized, so the trailing-dot form is rejected too; this is an auxiliary defence, not a security boundary); `compliance-scan` scans for `ilinkai/qrcode/bot_token/itchat/wechaty/padlocal/wechatferry` |
| 2 | Does it attempt to process WeChat group chat messages? | **No — two-layer rejection, no switch** | `gates.ts › checkRouteShape` (`WECHAT_GROUP_*`) + `policy.ts › decideAll` (`skipped_group_forbidden`); `test/private-only.spec.ts` |
| 3 | Is there any MTProto / Telethon / Pyrogram personal-account login code? | **No** | Dependencies are only `ws/yaml/zod`; `compliance-scan` forbidden words + dependency allow-list; `config/load.ts` rejects the related configuration keys |
| 4 | Are Telegram routes off by default, and is there a cross-border confirmation switch? | **Yes: 0 cross-border routes by default; the switch is four confirmations + version validation; a missing item refuses to start** | `schema.ts › defaultComplianceSettings`; `gates.ts › evaluateCrossBorderGate`; `preflight.ts`; `test/preflight.spec.ts`; `main.ts` startup banner and risk notice |
| 5 | Is there an explicit consent mechanism for forwarding other people's messages, and is it open by default? | **The mechanism exists; fully closed by default, and third-party routes do not exist by default** | `contentOwner` has no default value; `THIRD_PARTY_CONSENT_DISABLED` / `THIRD_PARTY_NOTICE_MISSING`; `consent.ts` (per conversation + per route `routes[]`); `forward.ts › handleConsentCommand`; `test/consent.spec.ts`, `test/regression-audit.spec.ts` |
| 6 | Do logs accidentally print message content? | **No** | `logger.ts` allow-list + value replacement; canary assertions in `test/redaction.spec.ts` |
| 7 | Do the README and COMPLIANCE.md genuinely spell out the risks? | **Yes** | README opening statement + 7 risk warnings (account bans, cross-border transfer, network compliance, disclaimer); this document maps every item to a code location and a "not applicable" conclusion |
| 8 | Does preflight refuse to start and print compliance guidance? | **Yes, exit 78** | `preflight.ts › runPreflight/formatPreflightFailure`; `main.ts`; `test/preflight.spec.ts` |

---

## 9. Change control (for future maintainers)

The following changes **must** be accompanied by an update to this document, a bump of `riskNoticeVersion` / `noticeVersion`, and additional tests; otherwise they count as breaking the compliance baseline:

1. Enabling group-chat processing on any platform;
2. Adding receipt, download or forwarding of any new media type (images / voice / files);
3. Adding any channel that logs into a platform under a personal account (especially a Telegram userbot);
4. Introducing message content persistence (database, queue, cache, logs, crash reports);
5. Loosening the cross-border gate (for example removing `operator`, removing version validation, adding `--force`);
6. Loosening the third-party content consent mechanism (for example allowing it by default, skipping the notice, or changing the keyword to "any reply counts as consent");
7. Adding any ability for this service to connect directly to official platform domains.

Suggested review method: `npm run check` (typecheck + static scan + tests) must be fully green; any of the changes above should be accompanied by a written argument for "why it is still compliant".

---

## 10. Residual risks and disclaimer

Residual risks this project cannot eliminate (the user must assess them):

1. Platform terms may change, and their interpretation rests with the platforms;
2. NapCat's unofficial nature makes account risk unavoidable;
3. After a Telegram cross-border transfer, the actual data processing is outside this project's control;
4. The consent mechanism cannot verify identity, cannot cover group members, and cannot recall content already sent;
5. The user may not have truthfully completed the Article 38 / Article 55 procedures;
6. The user may transmit sensitive personal information in messages, and this project performs no content recognition or blocking (deliberately not introduced);
7. The JS runtime cannot guarantee memory zeroization;
8. **Consent records are unsigned**: they can be forged locally and carry internal credibility only (see 6.3);
9. **Trust boundary**: `contentOwner`, `chatType` and `senderIsSelf/isSenderBot` all come from configuration or the gateway,
   and this service cannot verify them independently; these three determine "which messages get forwarded", so they are preconditions you must confirm yourself;
10. **The gateway side is not auditable**: the compliance of the EasyBot gateway itself (iLink authorization scope, NapCat login method,
    Telegram storage policy) is outside this repository's scope and is the biggest unknown of this project. Assess it yourself or ask the gateway provider to explain.

**This document is not legal advice. The author accepts no responsibility for the user's compliance status, account security, data leaks or third-party misuse.**
Before use, complete your own legal assessment and keep your own processing records (PIPL Article 56).
