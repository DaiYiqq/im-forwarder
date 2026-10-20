# im-forwarder · WeChat ↔ QQ ↔ Telegram message-forwarding router

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [繁體中文](README.zh-TW.md)

[![CI](https://github.com/DaiYiqq/im-forwarder/actions/workflows/ci.yml/badge.svg)](https://github.com/DaiYiqq/im-forwarder/actions/workflows/ci.yml)
[![License: MIT + Commons Clause](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

> ## ⚠️ Non-commercial use only — no paid services, no paid hosting
>
> This project is **for technical research and personal learning only**.
> The WeChat side connects through Tencent's **official iLink (ClawBot)** open capability,
> whose license is limited to **non-commercial** purposes. The [LICENSE](LICENSE) adds a
> Commons Clause that forbids **selling**, **paid hosting**, and **resale**.
> Use in any paid forwarding service, paid hosting, or commercial product is **not authorized**.
>
> If you need commercial cross-platform sync, apply to the platforms for an official enterprise
> solution instead. Do not use this project for that purpose.

---

## 1. Risk warnings (read every item before installing)

1. **Research/learning only; commercial use forbidden.** See [LICENSE](LICENSE)
   (MIT + Commons Clause: no charging, no paid hosting, no resale).
2. **The WeChat side must use the official iLink (ClawBot) channel only**, endpoint
   `ilinkai.weixin.qq.com` (authorization is completed by the EasyBot gateway).
   This repository contains **no** WeChat login, QR-code, cookie, web-protocol, iPad-protocol,
   hook or reverse-engineering code.
   The WeChat side handles **private chats only**: group messages are neither received nor sent,
   and friend lists, message recall or history queries are not used.
   iLink grants a **non-commercial** license — any paid use also violates that license.
3. **The QQ side uses NapCat + OneBot 11, which is _not_ an official QQ bot channel.**
   Logging a personal QQ account into NapCat carries **login verification, frequent disconnects
   and account-ban** risks. **Use a dedicated throwaway account; never your main account.**
   You bear all consequences.
4. **Telegram must use the official Bot API only** (a bot created via BotFather).
   Userbot approaches — MTProto, Telethon, Pyrogram, or any login as a personal account —
   are **strictly forbidden** and absent from this codebase. A bot can only receive messages
   users send to it or authorized messages in groups where it is a member; this project never
   reads private chat history or other people's conversations.
5. **Cross-border data transfer (important).** Telegram servers are located **outside China**.
   Forwarding messages from WeChat/QQ to Telegram **may constitute a "transfer of personal
   information abroad" under Article 38 of China's PIPL**. Therefore:
   - Telegram forwarding is **disabled by default** and must be explicitly enabled in config;
   - enabling it requires an explicit confirmation that **only your own messages** are forwarded,
     never other people's chat content;
   - see [COMPLIANCE.md](docs/en/COMPLIANCE.en.md) for Articles 38/39 and the corresponding controls.
6. **Network access compliance.** Access to Telegram from mainland China is subject to applicable
   laws and regulations. Users must ensure their own network access is lawful.
   **This project provides and recommends no circumvention method**; no proxy/tunnel/obfuscation
   code exists in this repository.
7. **Disclaimer.** The authors accept no liability for account bans, data leaks, third-party abuse,
   or any unlawful use. Provided "as is" under the LICENSE, without warranty of any kind.

> This is not legal advice. For any personal-information processing decision, consult a qualified lawyer.

---

## 2. What it does / does not do

| | This project | Notes |
|---|---|---|
| Protocol layer | ❌ | WeChat iLink / NapCat / Telegram Bot API connections are handled by the **EasyBot gateway** |
| Forwarding routing | ✅ | `source platform:source conversation → target platform:target conversation` matrix; any pair |
| Message types | text only | Everything else is **explicitly acknowledged and skipped** — never silently dropped, never decoded |
| WeChat group chats | ❌ | Rejected at compile time and runtime; **no config switch can enable it** |
| Message persistence | ❌ | No database, no queue on disk, no cache; content lives only in memory |
| Content logging | ❌ | Log fields are whitelisted — there is no field that could hold content |
| Third-party content | off by default | Requires the notice-and-consent flow; not forwarded before consent |
| Telegram cross-border | off by default | Four confirmations required; missing any one **refuses to start** |

### Data flow

```
                    ┌──────────────────────────────────────────┐
  WeChat private ──▶│  EasyBot unified IM gateway              │
  QQ private     ──▶│  · per-platform PlatformAdapters         │
  Telegram Bot   ──▶│  · unified REST (send) + WebSocket (in)  │
                    └───────────────────┬──────────────────────┘
                                        │  normalized events / send requests
                                        ▼
                    ┌──────────────────────────────────────────┐
                    │  im-forwarder (this repo)                │
                    │  preflight → route matrix → policy chain │
                    │  → text transform → send → whitelist log │
                    └──────────────────────────────────────────┘
```

This service **holds no platform credentials** — only one token for the EasyBot gateway,
read from an environment variable.

---

## 3. Quick start

### Prerequisites

- Node.js ≥ 20 (developed on Node 24)
- A running **EasyBot gateway** where the following are already configured:
  - WeChat: official iLink (ClawBot) channel authorization (QR authorization done by the gateway)
  - QQ: NapCat login (**use a throwaway account**)
  - Telegram (optional): a BotFather bot connected to the gateway
- This repository does none of the above and will not do it for you.

### Install

```powershell
git clone https://github.com/DaiYiqq/im-forwarder.git
cd im-forwarder
npm install
Copy-Item config/config.example.yaml config/config.yaml
# Note: this project does NOT load .env files (no dotenv dependency).
# The gateway token must be provided as a real environment variable.
```

### Provide the token (environment variable only)

```powershell
$env:EASYBOT_TOKEN = "<your EasyBot gateway token>"
```

### Self-check before every start

```powershell
npx tsx src/main.ts --config config/config.yaml --self-check
# exit 0 = config + compliance checks passed; 78 = refused (prints each reason and how to fix)
```

### Run

```powershell
npm start
```

### Local integration without any real account (mock gateway)

```powershell
npm run mock    # terminal A: fake gateway, no platform contacted
# terminal B: point baseUrl/eventsUrl at the printed address, then npm start
```

---

## 4. Routing matrix

Routing is a table of directed edges, **not pairwise hard-coding**:

```yaml
routes:
  - id: wx-private-to-qq          # WeChat private → QQ conversation
    group: self-wx-qq             # one logical chain; loop protection is per group
    contentOwner: self            # required: self | third-party (no default)
    from: { platform: wechat, conversationId: "wxid_xxx", chatType: private }
    to:
      - { platform: qq, conversationId: "10001", chatType: private }

  - id: qq-to-wx-private          # reverse edge, same group
    group: self-wx-qq
    contentOwner: self
    from: { platform: qq, conversationId: "10001", chatType: private }
    to: { platform: wechat, conversationId: "wxid_xxx", chatType: private }
```

Compile-time rules (violation ⇒ **refuse to start**, no automatic resolution):

- `chatType` must be `private` (all platforms; groups are unsupported anywhere);
- `from` and `to` must differ (no self-loop);
- one `group` must have a consistent `contentOwner`;
- duplicate route ids / duplicate edges ⇒ failure;
- cycles require `loopGuard.enabled: true`, and cycles must not span groups.

Loop protection is three-layered: **echo `messageId` → short-lived HMAC fingerprint (memory only) →
hop budget** (default `maxHops: 1`).

---

## 5. Compliance switches (default off; missing = refuse to start)

### Cross-border transfer (PIPL Art. 38/39)

```yaml
compliance:
  telegramCrossBorder:
    enabled: true
    operator: "Your Name"                        # who enabled it — auditable
    acknowledgedAt: "2026-10-18T12:00:00+08:00"  # ISO 8601
    selfMessagesOnlyConfirmed: true              # own messages only
    riskNoticeVersion: "2026-10-18.v1"           # changing the notice invalidates old acks
```

Any missing item or version mismatch ⇒ `CROSS_BORDER_GATE_CLOSED` /
`CROSS_BORDER_ACK_INCOMPLETE` ⇒ **exit 78**.

### Other people's chat content (PIPL Art. 23)

There are **no** third-party routes by default. To forward someone else's content you must enable
the consent mechanism and supply the required notice elements (`receiver.*`) for every target;
the first message is **not forwarded** — a notice is sent, and forwarding starts only after the
other party replies with the consent keyword. Cross-border chains need **two independent consents**.
Details: [docs/en/CONSENT-FLOW.en.md](docs/en/CONSENT-FLOW.en.md), [COMPLIANCE.md](docs/en/COMPLIANCE.en.md).

---

## 6. Logging and privacy

```json
{"ts":"2026-10-18T12:34:56.789Z","level":"info","event":"forward","status":"forwarded","routeId":"wx-private-to-qq","sourcePlatform":"wechat","targetPlatform":"qq","latencyMs":42}
```

- Only whitelisted fields (`ts/level/event/routeId/sourcePlatform/targetPlatform/status/errorCode/...`);
- **no message content, no conversation IDs, no nicknames**;
- over-long string values become `[omitted:N]` so content cannot be smuggled into a legal field;
- enforced by `test/redaction.spec.ts` with a canary string, not by promise.

---

## 7. Known limitations (no sugar-coating)

1. **Gateway contract must be verified.** Field/path differences are absorbed via
   `gateway.fieldMap` and `gateway.send.path` — never by adding a platform SDK.
   See [docs/en/GATEWAY-CONTRACT.en.md](docs/en/GATEWAY-CONTRACT.en.md).
2. **Text only.** Media is skipped with an explicit reply; no download or decoding.
3. **No group chats** on any platform (a group cannot give per-member consent).
4. **Consent boundaries:** it proves the reply came from that private conversation, not that the
   replier is the data subject; already-forwarded copies cannot be recalled.
5. **Memory wiping is not guaranteed** — JS runtimes offer no controlled zeroization.
   What we do guarantee: no disk, no logs, no queue.
6. **NapCat bans/disconnects cannot be avoided.**
7. **`contentOwner` is self-declared** — labelling someone else's chat as `self` bypasses consent.
   The program cannot verify chat ownership.
8. **Consent records are unsigned** — anyone who can write `data/consent.json` can forge consent.
   They carry internal credibility only.
9. **Trust boundary is the gateway** — `chatType`, `senderIsSelf`, `senderIsBot` all come from the
   gateway. If it misreports, the corresponding hard gates fail. Gateway-side compliance is the
   biggest unknown and is out of this repository's control.

---

## 8. Quality gate

```powershell
npm run check        # typecheck + static compliance scan + full test suite (63 tests)
npm run typecheck
npm run compliance:scan   # forbidden words / dependency allow-list / console.log
npm test
```

CI: [.github/workflows/ci.yml](.github/workflows/ci.yml). An independent audit report lives in
[docs/en/AUDIT.en.md](docs/en/AUDIT.en.md) (8 acceptance criteria, black-box exit codes, PoC, remediation log).

---

## 9. Developer contact

| Channel | Details |
|---|---|
| Developer | **戴亿 (DaiYi)** |
| GitHub | [@DaiYiqq](https://github.com/DaiYiqq) |
| Email (QQ) | **1703205607@qq.com** |
| Email (Gmail) | **daiy91004@gmail.com** |
| QQ | **1703205607** |
| WeChat | **daiyi091004** |
| Douyin (抖音) | **daiyi091004** |
| Issues (preferred for bugs) | [github.com/DaiYiqq/im-forwarder/issues](https://github.com/DaiYiqq/im-forwarder/issues) |

- For **security vulnerabilities or abuse reports**, read [SECURITY.md](SECURITY.md) first —
  please do not paste credentials, chat content or personal data into public issues.
- Please do not send sensitive personal information through any contact channel.
- Full contact policy: [CONTACT.md](CONTACT.md).

---

## 10. Community & co-maintenance

This project is meant to be **maintained by the community**, under an explicit red line:
**compliance invariants may never be weakened.**

- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, code style, mandatory checks,
  and the list of compliance invariants a PR must not break.
- **Governance:** [GOVERNANCE.md](GOVERNANCE.md) — roles, review rules, release process.
- **Translations:** [TRANSLATIONS.md](TRANSLATIONS.md) — Simplified Chinese (README.md) is canonical; English and other languages
  are best-effort and community-maintained.
- **Code of conduct:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **Compliance discussion:** use the *compliance concern* issue template.
- **Good first issues:** label `good first issue`; docs/translation fixes are always welcome.

Who can merge what: see [GOVERNANCE.md](GOVERNANCE.md). Every PR that touches
`src/compliance/**`, `src/config/schema.ts`, `LICENSE` or `COMPLIANCE.md` needs a second reviewer
and must keep `npm run check` green.

---

## 11. License

MIT **+ Commons Clause**: use, copy, modify, merge, publish, distribute, sublicense are allowed;
**selling, paid hosting and resale are not**. See [LICENSE](LICENSE).
This combination is **not** an OSI-approved open-source license — do not treat it as one.

Not affiliated with Tencent, Tencent QQ or Telegram. All trademarks belong to their owners.
