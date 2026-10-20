# Operations Checklist (Before Launch / Daily / Incident Response)

> **Language / 语言**：[English](OPERATIONS.en.md) | [简体中文](../OPERATIONS.md)
> English translation of `docs/OPERATIONS.md`; the Simplified Chinese version is authoritative.

> This is not an "install it and it just runs" manual, but a checklist that **must be ticked off item by item before going live**.
> Most compliance incidents are not caused by wrong code, but by "assuming it was configured correctly".

---

## A. Before launch · Legal and platform side (in order)

- [ ] **A1. Confirm that the use is non-commercial**
      WeChat iLink(ClawBot) authorization is limited to non-commercial purposes; the LICENSE also prohibits charging / paid hosting / resale.
      As soon as your use brings income to anyone at all (including "an internal tool that is sold externally"), stop.
- [ ] **A2. Confirm that only your own messages are forwarded**
      Default routes should all be `contentOwner: self`, i.e. "you ↔ your other account".
      As soon as third parties are involved, go to A3; do not skip it.
- [ ] **A3. If third-party content is involved: complete the notice-and-consent mechanism**
      `thirdPartyConsent.enabled: true`, and fill in all six `receiver` elements for every target.
      Check each one: recipient name, contact details, processing purpose, processing method, data categories, retention period.
      See [CONSENT-FLOW.en.md](CONSENT-FLOW.en.md).
- [ ] **A4. If Telegram is involved: complete the cross-border compliance self-assessment** (this tool does not do it for you)
      - [ ] Article 38 route, choose one of three: security assessment / protection certification / standard contract (or confirm that an exemption applies)
      - [ ] Article 39 notice: name, contact details, purpose, method and data categories of the overseas recipient, and how rights can be exercised
      - [ ] Article 39 separate consent: obtain independent consent from yourself (or from the third party)
      - [ ] PIPIA under Articles 55/56: complete the assessment and **keep the report for at least three years**
      - [ ] Explicitly state "only my own messages are forwarded" (`selfMessagesOnlyConfirmed: true` in the configuration is a promise, not proof)
- [ ] **A5. Confirm that the network access is lawful**
      Accessing Telegram from mainland China is subject to the relevant laws and regulations; this project neither provides nor recommends any circumvention.
- [ ] **A6. Confirm that group chat is out of scope**
      Group chats on any platform are rejected by this project. If the business genuinely needs group chat, use another compliant solution.

---

## B. Before launch · Technical side

> Prerequisite: this repository only ships `config/config.example.yaml`. Before a real run, execute
> `Copy-Item config/config.example.yaml config/config.yaml`, then follow B3/B4 to set the token and self-check.

- [ ] **B1. Log in to QQ (NapCat) with a dedicated secondary account**
      A primary account is strictly forbidden. The ban risk is yours to bear; "let me try with my primary account first" is not accepted.
- [ ] **B2. The EasyBot gateway is ready**
      - WeChat: official iLink(ClawBot) channel authorization completed (QR scan/authorization on the gateway side)
      - QQ: NapCat logged in with the secondary account, OneBot 11 available
      - Telegram (optional): the BotFather bot has been created and connected to the gateway
      - Both the gateway's REST send endpoint and its WS event endpoint are reachable
- [ ] **B3. Tokens live in environment variables only**
      `$env:EASYBOT_TOKEN = "..."`; do not write it into `config/config.yaml`, and do not commit `.env`.
      The configuration loader rejects any key resembling cookie / bot_token / ilink_* / qrcode / MTProto.
- [ ] **B4. The configuration self-check passes**
      ```powershell
      npx tsx src/main.ts --config config/config.yaml --self-check
      # must exit 0; on 78, fix each item as instructed (there is no --force)
      ```
- [ ] **B5. Verify the gateway contract**
      Check `gateway.baseUrl / eventsUrl / send.path / fieldMap` against [GATEWAY-CONTRACT.en.md](GATEWAY-CONTRACT.en.md),
      especially whether `data.conversation.type` really yields `private`.
- [ ] **B6. Conversation IDs match the real IDs**
      `conversationId` must be the **original ID** that appears in gateway events, not a nickname or remark.
      How to check: look at one real event on the gateway side (this service does not print conversation IDs; that is intentional).
- [ ] **B7. All quality gates green**
      ```powershell
      npm run check    # typecheck + compliance:scan + the full test suite
      ```
- [ ] **B8. Process supervision**
      Run it under systemd / a Windows service / pm2; **do not** run `npm start` in the foreground for long periods.
      Note: the supervisor must not enable "dump memory on crash" (that would write message bodies to disk).
- [ ] **B9. Disk and backups**
      The `data/` directory holds only consent metadata; backing it up is enough (do not back up anything from the logs — the logs contain no message bodies anyway).
      Confirm that `data/` and `config/config.yaml` are not under version control (`.gitignore` already handles this).

---

## C. Startup and observation

```powershell
$env:EASYBOT_TOKEN = "..."
npx tsx src/main.ts --config config/config.yaml
```

The startup banner should show (example):

```
──────────────────────────────────────────────────────────────
 im-forwarder · WeChat(iLink) ↔ QQ(NapCat) ↔ Telegram(Bot API)
 for technical research and study only
 non-commercial use · no paid services · no paid hosting
──────────────────────────────────────────────────────────────
[COMPLIANCE] wechat   = official iLink(ClawBot) · private chat only · via gateway | this service contains no WeChat login code
[COMPLIANCE] qq       = NapCat + OneBot11 via gateway | unofficial channel · risk of login verification / disconnection / account ban · a secondary account is required
[COMPLIANCE] telegram = official Bot API via gateway | cross-border gate: CLOSED
[COMPLIANCE] routes=2 edges=2 groups=1 | cross-border edges=0 inbound edges=0 | third-party content routes=0 | route cycles=1
[COMPLIANCE] body persistence: forbidden (no database / no queue / no disk cache) | body logging: forbidden (log field allow-list)
──────────────────────────────────────────────────────────────
```

**Taking a screenshot for the record is recommended**: it is at the same time evidence of "the current compliance configuration state".

### Exit codes

| Code | Meaning | Action |
|---|---|---|
| 0 | Normal exit | —— |
| 78 | Configuration/compliance pre-checks failed | Fix according to the printed remediation advice; there is **no** `--force` |
| 1 | Runtime error | Look at the log `errorCode` (contains no message bodies) |

---

## D. Daily operations

### D1. Log audit (once a week)

```powershell
# 0) This service only writes structured logs to stdout, **it does not write files**.
#    When running as a service, redirect it yourself (example):
New-Item -ItemType Directory -Force logs | Out-Null
npm start *>> logs\forwarder.log

# 1) Confirm there are no message bodies in the logs: the fields are allow-list keys only (see src/observability/logger.ts)
Get-Content logs\forwarder.log -Tail 200 | ForEach-Object { $_ | ConvertFrom-Json } |
  Select-Object ts,event,status,routeId,sourcePlatform,targetPlatform | Format-Table

# 2) Anomaly warning signals
#    rising send_failed ratio       → gateway / conversation ID / platform risk control
#    sudden spike in blocked_consent_pending → someone tried to send on a link without consent (should stay within design)
#    gateway_http_4xx        → authentication failure or wrong target conversation
```

### D2. Consent record maintenance

```powershell
# See how many consent records currently exist (metadata only)
if (Test-Path data\consent.json) {
  Get-Content data\consent.json -Raw | ConvertFrom-Json |
    Select-Object -ExpandProperty records | Get-Member -MemberType NoteProperty |
    Measure-Object | Select-Object Count
} else {
  "No consent records yet (mechanism disabled, or nothing recorded)"
}

# Clean up expired records / withdraw everything
Remove-Item data\consent.json    # after a restart every conversation must consent again
```

### D3. Loop check

If you find that "the same message is forwarded twice":

1. Confirm whether the gateway returns a `messageId` in the send response (when it does not, only the fingerprint layer is the fallback);
2. Do not solve it by "turning off loop protection" — the configuration forces `loopGuard.enabled: true` (when a cycle exists);
3. Check whether someone configured the same message with several target edges at once.

### D4. Upgrade process

```powershell
git pull
npm ci
npm run check                       # must be all green
npx tsx src/main.ts --self-check    # must exit 0
# restart the service; watch the send_failed ratio for 5 minutes
```

---

## E. Incident response

| Scenario | Action |
|---|---|
| Account suspected of platform risk control/ban (QQ) | Stop the service immediately → `stop`; switch to another secondary account; **do not** log in again repeatedly |
| Suspect that messages reached a conversation they should not have | Stop the service → inspect `routes` and `group` → fix the configuration → restart only after `--self-check` passes |
| Someone asks to withdraw their information | Have them reply "撤回同意"; or delete `data/consent.json` and restart; copies already forwarded must be handled manually on the other party's platform |
| Token leaked | Reset the token on the gateway side → update the environment variable → restart; this service does not store tokens, so there is nothing local to clean up |
| Configuration was modified by someone | Use `--self-check` to see the compliance conclusion for the diff; the git history should contain a review record of changes under `config/` |
| Need to stop everything temporarily | `Ctrl+C` (SIGINT) closes the WS connection gracefully and then exits |

---

## F. Things you must absolutely never do

1. ❌ Enable group chat routes on any platform —— startup is refused, and it was never compliant in the first place;
2. ❌ Set `contentOwner` to `third-party` without reading the notice text;
3. ❌ Fill in `acknowledgedAt` at will just to get Telegram running (that is forging an audit trail);
4. ❌ Assume that setting the log level to `debug` means "you can see the content" —— this service has **no** code path that prints message bodies, so changing the level will not make any appear;
5. ❌ Add a database/queue to the project to "improve reliability" —— that would persist message bodies and directly violate Requirement 8;
6. ❌ Spread the claim "this is a compliance tool" beyond the README —— it is only a technical constraint that **reduces the likelihood of overstepping**.
