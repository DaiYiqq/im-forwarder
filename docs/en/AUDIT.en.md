# im-forwarder · Independent Compliance Audit Report (English summary)

> **Language / 语言**：[English](AUDIT.en.md) | [简体中文](../AUDIT.md)
> This is the English **summary** of `docs/AUDIT.md`, not a full translation. The Simplified Chinese
> version is authoritative; if they conflict, the Chinese text prevails. All findings, verdicts,
> evidence pointers, error codes and exit codes are retained; per-configuration construction details
> and raw command transcripts are condensed.

| Item | Content |
|---|---|
| Audit target | `D:\openclaw\im-forwarder` (code version `0.1.0`, risk-notice version `2026-10-18.v1`) |
| Audit stance | Independent auditor commissioned by the client. README / COMPLIANCE.md self-descriptions are not accepted at face value; only code, configuration and command output are accepted. The method was "try hard to prove it non-compliant". |
| Audit date | 2026-10-18 (working-copy snapshot and key file hashes: see §1.1 "version anchor") |
| Environment | Windows, Node v24.21.0, npm 11.19.0, dependencies installed (lockfileVersion 3) |
| Conclusion | **No blocking-level non-compliance found.** Of the 8 acceptance criteria, 5 "pass" and 3 "pass with reservation"; there is also one bypassable defence boundary, a set of documentation inaccuracies and trust-boundary risks — see §8. |

> This report is not legal advice. Every conclusion concerns only "whether this repository's code
> has the claimed capability/constraint"; it does not assess whether any deployment is lawful. No real
> platform was contacted, no dependency was installed, and `src/**`, `test/**`, `config/**`,
> `package.json` and the existing documents were not modified; the only file written was the report itself.

---

## 1. Scope and method

### 1.1 Coverage

- **50** non-`node_modules` files (`Get-ChildItem -Recurse -Force` full enumeration including hidden
  files; that working copy had no `.git`).
  - `src/**`: 22 TypeScript files, ~3,890 lines (all read line by line);
  - `test/**`: 11 files (10 specs + harness), ~2,230 lines; all 59 cases actually executed;
  - `scripts/`: 3 (`compliance-scan.mjs` in full, `test.mjs` in full, key behaviour of `mock-gateway.ts`);
  - `config/config.example.yaml`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`,
    `.env.example`, `LICENSE`, `.github/workflows/ci.yml`;
  - `README.md` (277 lines), `COMPLIANCE.md` (376 lines), 4 `docs/*.md` files (~900 lines in total),
    all read line by line.
- Dependency layer: all 36 `node_modules/*` entries in `package-lock.json` and their dependency edges;
  the top-level `node_modules` directory list.
- Black-box layer: **24** temporary configurations/scripts (22 YAML + 1 PoC script + 1 forged
  `consent.json`, plus some stderr capture files; all under `%TEMP%\imf-audit-20261018\`, never written
  into the repository), each executed through the real process entry point `src/main.ts --self-check`
  with the real exit code read.

> **Version anchor (important).** During the audit the working copy changed once concurrently
> (2026-10-18 23:00:04 UTC+8): `src/compliance/preflight.ts` gained 7 **comment** lines (platform
> characterization, no logic change, 278→285), and `config/config.example.yaml` gained 5 **comment**
> lines (platform reminder, 148→153). The final conclusions, `npm run check` and all black-box probes
> were **re-run on the post-change working copy** and confirmed identical (exit 0 / 59 tests pass; a–e
> still all 78, default still 0). SHA-256 (first 12 hex): `preflight.ts=b05d6d489356`,
> `config.example.yaml=7d7c093d4902`, `gates.ts=2de4d4de65f2`, `forward.ts=f11883ad9654`.

### 1.2 Commands actually executed (summary)

| # | Command / tool | Purpose |
|---|---|---|
| 1 | `npm run check` (= `tsc --noEmit` + `compliance:scan` + `node scripts/test.mjs`) | Re-run the project's self-declared quality gate: measured **exit 0** — typecheck passed, static scan of 23 files with 0 findings, 59 tests / 59 pass / 0 fail |
| 2 | Independent `grep`/ripgrep scans ×15+ (src, scripts, test, config, docs, README, COMPLIANCE, per directory) | Repository-wide keyword audit, not relying on the project's own scanner |
| 3 | `node -e` (reading the lockfile, URL normalization checks) | Line-by-line verification of the dependency graph; verification of `URL.hostname` handling of trailing dots |
| 4 | `cmd /v:on /c "node --import tsx src/main.ts --config <tmp> --self-check >nul 2>nul & echo EXIT=!errorlevel!"` ×10 (including `config.example.yaml`) | Read real exit codes using the method specified by the client |
| 5 | Direct `node --import tsx src/main.ts ...` ×25+ | Capture violation codes, banner and configuration summary from stderr; `--force` / `--skip-*` / environment-variable bypass attempts |
| 6 | `node --import tsx <tmp>/poc-consent.mts` ×1 | Consent-bypass PoC (self-built `Forwarder` call chain, no network access) |
| 7 | Temporary YAML ×22 / temporary PoC script ×1 / forged `consent.json` ×1 | Black-box preflight, YAML parsing boundaries, consent bypass, consent-record forgery |

### 1.3 What this audit explicitly did NOT cover

See §8.2. The three most important: **no dynamic network capture** (no real platform was accessed);
**the compliance of the EasyBot gateway itself was not verified** (WeChat login authorization, NapCat
login, Telegram Bot API calls all happen on the gateway side and cannot be observed from this
repository); **no substantive legal judgment was made**.

---

## 2. Verdict on the 8 acceptance criteria

| # | Acceptance criterion | Verdict | One-line evidence |
|---|---|---|---|
| 1 | Is there any WeChat login code that bypasses the official iLink? | **Pass** | No WeChat client / login / QR-code code anywhere in the repository; dependencies only `ws/yaml/zod`; the only network egress is "the gateway address in the configuration", and `config/load.ts` rejects platform credential keys (§5). One defence bypass boundary is attached (§8.1-F1; it does not change this verdict) |
| 2 | Does it attempt to process WeChat group chat messages? | **Pass** | Compile-time `WECHAT_GROUP_SOURCE_FORBIDDEN` / `WECHAT_GROUP_TARGET_FORBIDDEN` (`gates.ts:154-199`) + runtime `skipped_group_forbidden` (`policy.ts:60-62`), with no configuration switch; black-box measured exit 78 |
| 3 | Is there any MTProto / Telethon / Pyrogram personal-account Telegram login code? | **Pass** | 0 implementations in code, 0 related packages in dependencies, no `*.py` / `*.session` artefacts; the terms occur only in "forbidden lists / documentation statements" (§5.2 covers this item by item) |
| 4 | Are Telegram routes off by default, and is there a cross-border confirmation switch? | **Pass (with reservation)** | Default configuration has 0 Telegram routes, gate defaults to CLOSED; the four elements + version validation, missing any one ⇒ exit 78. Reservation: **inbound** (Telegram-source) routes do not trigger the cross-border gate; black-box measured exit 0 (§3.1 supplementary item f) |
| 5 | Is there an explicit consent mechanism for forwarding other people's messages, rather than it being on by default? | **Pass (with reservation)** | `contentOwner` has no default value; mechanism not enabled → `THIRD_PARTY_CONSENT_DISABLED`; at runtime, no consent ⇒ always `blocked_consent_pending`; a genuine "notice → separate consent → record → revocable" flow. Reservations: `contentOwner` is a self-declared field, consent records are locally forgeable, and the granularity did not match the documentation (§4, §8) |
| 6 | Did the logs accidentally print message content? | **Pass** | Field allow-list + runtime `pick` + whole-value replacement for over-long values (`logger.ts:19-32,93-133`); all 15 `.text` references in the repository verified not to reach the logs (§6.1); no `console.log` in `src/`; 59 tests include canary assertions |
| 7 | Do the README and COMPLIANCE.md genuinely spell out the risks rather than offering a template disclaimer? | **Pass (with reservation)** | Risks are tied to mechanisms and statutory articles item by item, with code locations; the non-commercial prohibition precedes the installation steps. Reservation: 8 statements were "written but not implemented, or written wrongly" (§7.3) |
| 8 | Preflight: when forwarding other people's messages or cross-border Telegram is enabled without the confirmation, does the process refuse to start and print compliance guidance? | **Pass** | 5/5 violating configurations measured **EXIT=78**, with per-item Chinese reasons and remediation advice on stderr; no `--force` / `--skip-*` / environment-variable bypass (§3) |

---

## 3. Black-box preflight results (self-built configurations → real process exit codes)

### 3.1 The five configurations required by the client, plus the default

Execution method (each run with `$env:EASYBOT_TOKEN="t"` set):

```powershell
cd D:\openclaw\im-forwarder
cmd /v:on /c "node --import tsx src/main.ts --config <temp.yaml> --self-check >nul 2>nul & echo EXIT=!errorlevel!"
```

| Config | Construction | Expected | Measured exit code | stderr violation code (full transcripts in the original appendices) |
|---|---|---|---|---|
| a | Telegram target + entire compliance section omitted (all gates off) | 78 | **EXIT=78** | `CROSS_BORDER_GATE_CLOSED` (listing enabled=false / missing operator / missing acknowledgedAt / selfMessagesOnlyConfirmed=false line by line) |
| b | Telegram target + `telegramCrossBorder.enabled: true`, with operator/acknowledgedAt/selfMessagesOnlyConfirmed missing | 78 | **EXIT=78** | `CROSS_BORDER_ACK_INCOMPLETE` |
| c | `contentOwner: third-party` + complete receiver + consent mechanism at default (off) | 78 | **EXIT=78** | `THIRD_PARTY_CONSENT_DISABLED (route colleague-wx-to-qq)` |
| d | WeChat source with `chatType: group` | 78 | **EXIT=78** | `WECHAT_GROUP_SOURCE_FORBIDDEN (route wx-group-source)` |
| e | `gateway.baseUrl: https://ilinkai.weixin.qq.com` | 78 | **EXIT=78** | `DIRECT_PLATFORM_ENDPOINT` |
| default | `config/config.example.yaml` | 0 | **EXIT=0** | prints `自检通过：配置与合规前置检查均未发现问题（未连接网关、未发送任何消息）` ("self-check passed: configuration and compliance preflight found no issues — no gateway connection, no message sent") |

Supplementary probes (not requested by the client, used to confirm that the gate really can be
opened and that failure reasons are isolated):

| Config | Construction | Measured | Note |
|---|---|---|---|
| f | Telegram **as a source only** (inbound edge), no confirmations at all | **EXIT=0** | banner shows `出境边=0 入境边=1` ("cross-border edges=0, inbound edges=1"), proving inbound routes do not trigger the gate (reservation, see §2-4) |
| g | third-party + complete notice elements + `thirdPartyConsent.enabled: true` | **EXIT=0** | the legitimate path starts, showing that the 78 in case c is not a blanket rejection |
| h | Telegram target + all four elements + correct `riskNoticeVersion` | **EXIT=0** | the gate really does open when all four elements are present |
| i | Same as h but `riskNoticeVersion: "2020-01-01.v0"` (stale version) | **EXIT=78** | `CROSS_BORDER_ACK_INCOMPLETE`, with an explicit reason line: version mismatch requires re-confirmation |
| — | Default configuration but `EASYBOT_TOKEN` **unset** | **EXIT=78** | `GATEWAY_TOKEN_MISSING` |
| — | Configuration file does not exist / unknown field `routes[0].force` | **EXIT=78** | `CONFIG_INVALID` (not exit 1 — still handled as a compliance failure) |
| — | Violating configuration **without** `--self-check` (real startup path) | **EXIT=78** | proves the block is not limited to self-check mode; normal startup also refuses before establishing any connection |

### 3.2 Bypass attempts (all failed)

| Attempt | Result |
|---|---|
| `--force` | `[FATAL] … unknown argument: --force`, **exit 1**, does not start (`main.ts:47-77` accepts only `--config/-c`, `--self-check`, `--help/-h`) |
| `--skip-compliance`, `--skip-check` | same as above, exit 1 |
| Environment variables `SKIP_COMPLIANCE`, `COMPLIANCE_SKIP`, `IM_FORWARDER_FORCE`, `IM_FORWARDER_SKIP_COMPLIANCE`, `BYPASS_COMPLIANCE`, `EASYBOT_SKIP_COMPLIANCE` all set to 1, then running config a | still **EXIT=78** (in `src/`, `process.env` is used only to read the token; see `main.ts:90,105,156`, `preflight.ts:58`) |
| Static search for `--force\|--skip\|bypass\|skip-check\|no-compliance\|ignore-compliance` | in `src/`, `scripts/` only 2 comment hits (`preflight.ts:10,274` state that no bypass switch exists), no implementation |
| Commenting out the check branch | all 22 src files read line by line: `runPreflight()` is called unconditionally at `main.ts:105`; there is no `if (…) skip` branch |
| Omitting the `compliance` section from the configuration | all defaults are off (`schema.ts:204-234`), equivalent to the most conservative setting |
| YAML duplicate keys (two `routes:`) | **EXIT=78** `Map keys must be unique at line 12` (rejected by the YAML parser) |
| YAML merge key (`<<:`) | **EXIT=78**, schema reports `Unrecognized key(s) in object: '<<'` (merge is not expanded by default and strict mode rejects it) |
| `enabled: "true"` (a string) / unknown fields | rejected by the schema → **EXIT=78** |

> The only defence boundary bypass found was not in the startup gate but in the "no direct connection to
> platform domains" blocklist: `https://ilinkai.weixin.qq.com./api` (trailing dot) measured **EXIT=0**.
> See §8.1-F1. It yields no login capability and does not bypass criteria 1–8 in §2, but it did falsify,
> for that constructed case, the absolute statement in COMPLIANCE.md 3.1③/8-1 that "preflight rejects a
> baseUrl pointing at ilinkai". **Status: fixed during remediation (§9).**

---

## 4. Consent-bypass PoC results

### 4.1 Method

A temporary script `%TEMP%\imf-audit-20261018\poc-consent.mts` calls the project's real modules directly
(`loadConfig` → `compileMatrix` → `ConsentService` + `ConsentStore` + `LoopGuard` + the real `Forwarder`),
with a fake gateway injected (send attempts are recorded only, no network), using two constructions:

- a PoC configuration where one WeChat private conversation `wechat:wxid_colleague` hits **two**
  third-party routes (→ `qq:10002`, `qq:10003`), with `thirdPartyConsent.enabled: true, persist: false,
  noticeCooldownMs: 0`;
- plus a hand-forged `consent.json` (generated locally, to test storage-layer integrity).

### 4.2 Results

| Scenario | Result | Reading |
|---|---|---|
| P1 The service's own account (`senderIsSelf: true`) sends 「同意转发」 | `["skipped_self"]`, `grant=false` | **Blocked**: `senderEligibleForConsent` in `forward.ts:72-81` requires `!senderIsSelf && !senderIsBot && chatType==="private"` |
| P2 Another bot (`senderIsBot: true`) sends 「同意转发」 | `["skipped_bot"]`, `grant=false` | **Blocked**: it cannot write a consent record on someone else's behalf |
| P3 A message body containing the embedded text 「我同意转发这条消息」 ("I agree to forward this message") | `["blocked_consent_pending","blocked_consent_pending"]`, `grant=false` | **Blocked**: `classifyCommand` requires an exact match on the whole message (`consent.ts:112-126`), not containment |
| P4 「同意转发」 from a sender with `senderIsBot: false` (the gateway did not mark that sender as a bot) | `["consent_recorded"]`, `grant=true` | The mechanism allows it by design. **This shows that eligibility relies entirely on the gateway-reported `senderIsSelf`/`senderIsBot`** (default `false`, `mapping.ts:183-184`): if the gateway omits the bot flag, another bot can write a consent record |
| P5 One ordinary message body after authorization | `["forwarded","forwarded"]`, targets `[qq:10002, qq:10003]` | **One consent authorized both third-party routes of the same conversation**: the actual granularity was "conversation" (`consent.ts:48-50`), not the "conversation + route" stated in `COMPLIANCE.md:93` (finding F3 / D1 — **fixed during remediation, §9**) |
| F1 Hand-forged `consent.json` (future `expiresAt`, valid noticeVersion) | `hasGrant=true`, `recordCount=1` | `consent-store.ts:78-104` performs shallow structural validation only, with **no signature/HMAC**; consent can be forged locally |
| F2 Extra field `injectedExtra` injected into a forged record | still present after rewriting | `load()` does not validate the record's internal field set; injected content is written back verbatim by `flush()` |

### 4.3 Conclusion (regarding acceptance criterion 5)

- The abuse scenario the client had in mind — "the service's own account, or another bot, sends
  「同意转发」 once and thereby writes a consent record on someone else's behalf" — **is effectively
  blocked when the gateway correctly reports `senderIsSelf`/`senderIsBot`** (P1/P2; the project's own 59
  tests contain a same-named assertion for each, and both passed in this run).
- Remaining: eligibility and `contentOwner` attribution are both "self-declared / gateway-reported" in
  nature and cannot be verified by the code; and the consent-record file has no integrity protection.
  Both were partially disclosed in COMPLIANCE.md's "capability boundaries" (identity cannot be
  verified), but "consent records can be forged locally" was **not** disclosed. See §8.

---

## 5. Dependency and keyword audit

### 5.1 Dependencies (independent of the project's own scanner)

`package.json`: `dependencies` = `ws ^8.18.0`, `yaml ^2.5.1`, `zod ^3.23.8` — consistent with the
client's requirement, no extra entries. `devDependencies` = `@types/node`, `@types/ws`, `tsx`,
`typescript` — consistent. No `peerDependencies` / `optionalDependencies` / `bundledDependencies`.

`package-lock.json` (lockfileVersion 3): 36 `node_modules/*` entries; after checking each dependency
edge, **all are explainable**:

| Package | Origin | Dependency edges |
|---|---|---|
| `ws`, `yaml`, `zod`, `typescript` | direct dependency | none |
| `tsx` | dev | → `esbuild` |
| `esbuild` + 26 `@esbuild/<platform>` | tsx dependency | none |
| `fsevents` | optional (macOS) | none |
| `@types/node` | dev | → `undici-types` |
| `@types/ws` | dev | → `@types/node` |
| `undici-types` | @types/node dependency | none |

Conclusion: **no `node-telegram-bot-api`, `telegraf`, Telethon-class, `wechaty`/`padlocal`/`wechatferry`,
`napcat`/`oicq`/`go-cqhttp`, `sqlite`/`redis`/`bull`/`amqplib` or any other suspicious package**; no
postinstall/script injection was found. The content of files inside `node_modules` and supply-chain
integrity were **not** audited (see §8.2).

### 5.2 Repository-wide keyword audit (independent grep, separating "policy statements" from "implementations")

Scanned words: `telethon|pyrogram|mtproto|tdlib|api_hash|session_string|userbot|ilinkai|ilink_bot|bot_token|qrcode|itchat|wechaty|padlocal|wechatferry|wcferry|com.tencent.mm|console.log|group_msg` (case-insensitive).

**`src/**` has 5 hits, all judged "compliant hits":**

| Location | Content | Why compliant |
|---|---|---|
| `src/config/load.ts:44` | forbidden-key regex `/bot_?token\|ilink\|qrcode\|login_?token\|scan_?code/i` | This is the **defensive definition itself**: such keys in the configuration cause startup to be refused (`load.ts:116-119`). Not a capability |
| `src/config/load.ts:45` | the Chinese reason string for the rule above | comment/string — a policy statement |
| `src/config/load.ts:52` | forbidden-key regex `/telethon\|pyrogram\|mtproto\|api_?hash\|session_?string\|userbot/i` | same: a defensive definition |
| `src/compliance/gates.ts:20` | `host: "ilinkai.weixin.qq.com"` inside the blocklist array | **a defence definition**: used to reject direct connections (`directPlatformHostViolation`). Not a call to that domain |
| `src/gateway/contract.ts:11` | comment "this repository contains no userbot (MTProto/Telethon/Pyrogram) code path" | comment / policy statement |

In `src/**`, `console.log` = **0** (all `src/` output goes through the `Logger` allow-list or the
startup banner's `process.stdout.write`; `scripts/` contains no actual `console.log(` call either, only
the word inside scanner comments/strings). `group_msg` = **0** (group chats are expressed through the
`chatType` / `group` fields, not WeChat protocol fields).

**Hits in other directories are all documentation/tests/scanner rules:**

| Location | Judgment |
|---|---|
| `scripts/compliance-scan.mjs:36-54` | the scanner's own forbidden-word rules, dependency allow-list and comments |
| `test/preflight.spec.ts:302,352-373` | **negative tests**: assert "baseUrl=ilinkai must be rejected" and "a bot_token in the configuration must raise an error" |
| `config/config.example.yaml:8` | comment "never write credentials here"; `tokenEnv: "EASYBOT_TOKEN"` is only an environment-variable name |
| `README.md:17,25,104`, `COMPLIANCE.md:20,163,167,182-189,336-338,353`, `docs/*`, `.env.example` | policy statements and article explanations, not implementations |

**Supplementary keyword scan (outside the client's list):** `login|sign.?in|qrcode|cookie|napcat|onebot|cqhttp|botfather|bot_api|tdlib|tdata` — every `src/` hit is a comment, banner text or forbidden-key
regex; `src/` contains no `child_process`, `node:net`, `node:dns`, `node:http(s)`, `eval(`, `new Function`
or `require(`. The whole repository (excluding `node_modules`) contains no `*.py`, `*.session`,
`*telethon*`, `*pyrogram*` or `*mtproto*` file.

**Network egress audit:** `src/` has only 3 network-related calls — `client.ts:183 fetch(this.endpoint)`
(endpoint = configured `baseUrl + send.path`), `events.ts:126 new WebSocket(this.wsUrl)` (= configured
`eventsUrl`), and `main.ts:205` constructing the event source. There is no hard-coded call to any
official platform SDK/domain (the official domains in `gates.ts` are used only for **blocklist
rejection**).

### 5.3 Limitations of the project's own `compliance:scan` (not relied upon for these conclusions)

- it scans only `src/**/*.ts` and `scripts/**/*.ts` (`compliance-scan.mjs:30`) — **not**
  `config/*.yaml`, `test/**`, `docs/**`, `package-lock.json` or `*.mjs`;
- comments are stripped before matching (`:117-166`), so "policy statements in comments" do not produce
  false positives — reasonable, but it also means **an implementation hidden in a comment would not be
  detected**;
- any word inside a constant named `FORBIDDEN|BLOCKLIST|BLACKLIST|DENYLIST|DENY_` is exempted
  (`:168-189`): if someone put violating strings into a constant with such a name, the scanner would
  silently exempt them (not the case in this project — verified by hand);
- string concatenation (`"tele"+"thon"`) and Base64/encoded implementations are not recognised; the
  dependency check compares only `package.json`, not the lockfile (the lockfile was checked
  independently here).

---

## 6. Logging and persistence audit

### 6.1 Logging (acceptance criterion 6)

**Defence structure (`src/observability/logger.ts`):**

1. an allow-list of 12 fields: `event, routeId, sourcePlatform, targetPlatform, status, kind, scope, errorCode, latencyMs, count, attempt, host` (`:19-32`);
2. before writing, each field is `pick`ed against the allow-list, and **non-allow-listed keys are dropped**
   (`:100-106`); `sanitizeLogValue` returns `undefined` for objects/arrays;
3. string values are stripped of control characters; values longer than 120 characters are replaced
   wholesale by `[omitted:N]`, **without keeping a prefix** (`:117-133`);
4. the `sink` defaults to `process.stdout.write` (`:69`); nothing is written to a file.

**Message-content flow check:** all 15 `.text` references in the repository were verified one by one:

- `forward.ts:77` → `consent.classifyCommand(message.text)` (whole-message keyword matching only, not logged);
- `forward.ts:308-314` → `renderForTarget` → the outbound request body `segments`;
- `forward.ts:357` → `loopGuard.rememberFingerprint` (HMAC digest, memory only);
- `loop-guard.ts:106-107` → HMAC (salt random per process, `loop-guard.ts:51,117-120`);
- `mapping.ts:164-171` → normalisation read; `contract.ts:74` / `transform.ts:88` / `client.ts:169` are
  field paths / rendering / request bodies.

**Not one** of them passes `text` into `Logger`, `process.stdout.write` or `process.stderr.write`. The
`logger.ts` allow-list contains no key such as `text/content/message/body`, and the `LogFields` type
forbids them at the type level. Among the 59 tests, `test/redaction.spec.ts` uses canary text to assert
that "no log line contains the content or any 8-character substring of it"; it passed in this run.

**Error paths:** `client.ts` actively calls `discardBody` (`:71-78,206-216`) and does not pass through
gateway response bodies / `errorCode` (`:238-241`); `events.ts` reports only `ws_bad_frame` on bad
frames and prints no frame content (`:181-202`); the fatal handler at `main.ts:247-256` prints only a
stable error code and the error type.

**Reservations (not message content, but part of the output surface):**

- preflight failure messages print the **target conversation ID** (e.g. the `message` of
  `THIRD_PARTY_NOTICE_MISSING` contains `target.platform:target.conversationId`,
  `preflight.ts:113-124`; the "duplicate route edge" `RouteMatrixError` also contains conversation IDs,
  `matrix.ts:132-137`). This differs from README §6's absolute statement "no conversation IDs" — it goes
  to stderr / the startup banner, not to the `Logger`, and contains no message content;
- `--self-check` prints `gateway.baseUrl` (`load.ts:156`). If a user put credentials into the URL
  userinfo, they would be printed; the configuration layer does not prevent this (not a content leak).

### 6.2 Persistence

- Repository-wide (excluding `node_modules`) audit for
  `writeFile|appendFile|createWriteStream|sqlite|better-sqlite|redis|queue|localStorage|indexedDB`:
  the **only write point** is `flush()` in `src/compliance/consent-store.ts:131-137` (temporary file +
  `renameSync` atomic replacement), writing `{version, records}` with
  `scopeKey / platform / conversationId / grants{noticeVersion, grantedAt, expiresAt} / updatedAt` —
  **no content, no messageId, no forwarded content**.
- No database, no queue, no on-disk cache, no log file on disk; logs go to stdout only, and the
  supervisor decides where they go.
- `data/` directory: it already existed in this working copy but was an **empty directory** (created
  before this audit; `loadConfig` calls `mkdirSync` unconditionally when `persist: true`,
  `load.ts:145-147`, so running tests or self-check creates/reuses the directory inside the
  repository). `data/` is excluded in `.gitignore` (`.gitignore:6`), which also excludes
  `config/config.yaml` and `.env*` (`:7-12`).
- However this working copy was **not a git repository** (`.git` absent), so whether `.gitignore`
  actually takes effect in the real repository could not be verified (see §8.2, F9).

---

## 7. Documentation QA (README / COMPLIANCE / docs)

### 7.1 README risk disclosure

All eight claims were checked against code/configuration and found **implemented**: the opening
non-commercial prohibition precedes the installation steps (LICENSE §2 Commons Clause + §3 Chinese
supplement; the startup banner at `main.ts:119-126` prints the same sentence); WeChat only via the
official iLink, with no login/QR/Cookie/protocol reverse-engineering; WeChat private chats only, no
friend directory / recall / history; NapCat is unofficial with login-verification / disconnect / ban
risks and a mandatory throwaway account; Telegram Bot API only, userbots strictly forbidden; cross-border
transfer risk + PIPL 38/39 + off by default + the four confirmations; lawful network access with no
circumvention method provided; disclaimer and "not legal advice".

### 7.2 COMPLIANCE.md coverage

Articles 23 (2.4), 38 (2.5), 39 (2.6), the WeChat ClawBot terms (3.1), the NapCat risk (3.2), the
"Telegram Bot API only, userbots excluded" reasoning (3.3) and the "not applicable" scenario table (§4)
all give code locations or an explicit "not applicable" judgment; Article 55 (2.9) explicitly states
"—— (explicitly not applicable)". **The client's requirement is met**, but the inaccuracies in §7.3
existed.

### 7.3 Documentation inaccuracies ("written but not implemented, or written wrongly" — none blocking)

| # | What the document said | What the code did | Impact | Post-remediation status |
|---|---|---|---|---|
| D1 | `COMPLIANCE.md:93` "⑥ consent is recorded at **conversation + route** granularity" | `scopeKey = platform:conversationId` in `consent.ts:48-50`, with no route dimension; PoC P5 showed one consent covering two third-party routes of the same conversation | the document overstated consent granularity; separate consent under PIPL may be challenged in "multiple recipients" scenarios | **Fixed (code + document)**: `ConsentGrant` gained `routes?: string[]`; `grant()` / `hasGrant()` / `check()` accept `routeId`; consent accumulates per route; old records without `routes` are read as "all routes"; COMPLIANCE §2.4⑥/§6.2 and CONSENT-FLOW §3/§4 updated |
| D2 | `docs/CONSENT-FLOW.md:194` referenced `test/fixtures/config.third-party.yaml` | the file does not exist (`test/fixtures/` contains only `harness.ts`) | the documented steps could not be executed | **Fixed**: the dead reference was removed and replaced by generic instructions |
| D3 | `docs/GATEWAY-CONTRACT.md:26` referenced `src/policy/` | the real directory is `src/routing/` | wrong path | **Fixed**: path corrected |
| D4 | `COMPLIANCE.md:176` "implements no risk-control evasion (**nothing adversarial beyond rate limiting**)" | there is no send-rate limiting in the code, only retry backoff (`client.ts:59-63`) | implied a rate-limiting mechanism that did not exist | **Fixed**: the non-existent "rate limiting" wording was removed |
| D5 | `docs/GATEWAY-CONTRACT.md:52` "the token is read only from the **configuration**" | the token value is read only from an environment variable; the configuration holds just the variable name (`schema.ts:71-72`, `main.ts:156`) | stated the opposite of the security model (the actual behaviour was safer) | **Fixed**: text now states the token comes from an environment variable only |
| D6 | `docs/OPERATIONS.md:109` audit command reads `logs\forwarder.log` | the service writes stdout only, no file (`logger.ts:69`) | the command depends on user-side redirection, which the document did not say | **Fixed**: the document now explains stdout and manual redirection |
| D7 | `README.md:98` suggests `Copy-Item .env.example .env` | there is no dotenv loader; `.env` is never read | already labelled "illustrative", but misleading | **Fixed**: the document now states clearly that `.env` is not loaded |
| D8 | `docs/GATEWAY-CONTRACT.md:295` "logs and diagnostics may contain message IDs only…" | `LOG_FIELD_WHITELIST` contains no messageId field | actual behaviour was stricter than documented, no leak risk | **Fixed**: the document now states that `messageId` is not in the log whitelist either |

### 7.4 Compliance helpers not on the production path

5 compliance helper functions/constants in `src` were never called on the production path
(`isWechatPrivateOnly`, `crossBorderStartupBlocker`, `formatCrossBorderNotice`, `crossBorderTargets`,
`endpointOf`; only defined/exported, and not referenced by tests either). The effective enforcement
points are `checkRouteShape` and `policy.ts`. This does not affect the compliance conclusions, but it
adds maintenance ambiguity where "the document points at functions that do not take effect".

---

## 8. Residual risks and not-covered items

### 8.1 Findings (ordered by severity) — **no blocking (cannot-ship) issue**

None of the items below changes the eight verdicts in §2; the client should nevertheless be aware of
them and require remediation or disclosure.

| # | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| F1 | **Medium-low** | The `DIRECT_PLATFORM_ENDPOINT` domain blocklist could be bypassed with a trailing dot: `gateway.baseUrl: https://ilinkai.weixin.qq.com./api` measured **EXIT=0**; `api.telegram.org.` and `weixin.qq.com.` bypass likewise (`URL.hostname` keeps the trailing dot, while `gates.ts:46-55` used strict equality / suffix comparison without normalisation). This grants no login capability, but the Bearer token would be sent to that domain, and the absolute claim in COMPLIANCE.md 3.1③/8-1 was falsified by the constructed case | measured in §3.2; `gates.ts:37-55` | **Fixed**: `hostnameOf()` lower-cases first and then strips all trailing dots (`ilinkai.weixin.qq.com.` ≡ `ilinkai.weixin.qq.com`); 3 regression cases; black-box re-test `direct-ilink-trailing-dot EXIT=78`; the document now calls the blocklist "an auxiliary defence to reduce mis-connection, not a security boundary" |
| F2 | **Low** | `data/consent.json` has no signature/integrity check, so "consent" could be forged by writing the file locally (PoC F1); `load()` also accepted extra fields inside a record and rewrote them verbatim (F2) | `consent-store.ts:78-104`; PoC | **Disclosed, code not changed** (for a single-machine personal tool, adding signatures would only move the key-management problem onto the local machine): COMPLIANCE §6.3 new row, §10 item 8, README known limitation 8 |
| F3 | **Low** | Consent granularity was actually "conversation" while COMPLIANCE.md said "conversation + route"; one 「同意转发」 could authorize several third-party routes of the same conversation (PoC P5 hit 2 targets) | `consent.ts:48-50`; `COMPLIANCE.md:93`; PoC P5 | **Fixed (code + document)**: `ConsentGrant.routes?`; `grant/hasGrant/check` take `routeId`; per-route accumulation; legacy records interpreted as all routes; see §9 |
| F4 | **Low (trust boundary)** | Eligibility for consent commands relies entirely on the gateway-reported `senderIsSelf`/`senderIsBot`; missing fields default to `false` (`mapping.ts:183-184`, `GATEWAY-CONTRACT.md:102-103`). If the gateway omits the bot flag, another bot's 「同意转发」 would be recorded (PoC P4) | `forward.ts:72-81`; PoC P4 | **Disclosed**: the check in `forward.ts::handle` is tightened to "not self + not bot + private chat", but the field values come from the gateway contract and the program cannot verify them independently. COMPLIANCE §6.3 + §10 item 9; README known limitation 9; `docs/GATEWAY-CONTRACT.md` now requires the gateway to output `sender.isBot` as a mandatory, trustworthy field |
| F5 | **Low (documentation)** | The 8 inaccuracies / dead references D1–D8 in §7.3 | see §7.3 | **Fixed**: corrected item by item (§9) |
| F6 | **Note (trust boundary)** | The group-chat hard gate relies on the `chatType` and `fieldMap` mapping pushed by the gateway; if the gateway misreports a group chat as `private`, or the user points `fieldMap.chatType` at a field that is always `"private"`, the gate fails. This service cannot determine the real conversation type itself | `policy.ts:60-62`, `mapping.ts:156-159`, `schema.ts:79-81` | **Disclosed** (cannot be eliminated in code: the service cannot see the platform's real conversation type): COMPLIANCE §6.3 new row; `docs/GATEWAY-CONTRACT.md` §boundary statement 3 now requires the gateway to guarantee it |
| F7 | **Note** | `contentOwner` is a self-declared field: a user can label "someone else's conversation" as `self` and bypass the consent mechanism entirely. This is the fundamental boundary of the design (COMPLIANCE 2.4/6.3 already partly stated "the program cannot determine") | `schema.ts:58`; COMPLIANCE §6.3 | **Disclosed** and raised from "partial statement" to an explicit risk item: COMPLIANCE §6.3 + §10 item 9; README known limitation 7 |
| F8 | **Note** | `loadConfig` called `mkdirSync(dataDir)` unconditionally when `persist: true` (default), so a `data/` directory was created in the repository even when the configuration was subsequently rejected by the compliance check; tests/self-check reproduce the side effect | `load.ts:145-147` | **Fixed**: the directory is now created only when `thirdPartyConsent.persist === true && enabled === true` (`preflight` tightened accordingly) |
| F9 | **Note** | The audited copy had **no `.git`**, so `.gitignore` effectiveness in the real repository could not be verified, nor whether content/credentials ever appeared in the commit history | filesystem enumeration | **Not handled** (the local copy was not a git repository). `.gitignore` is in place; the delivering party can `git init` and put it under version control |
| F10 | **Note** | The exemption mechanism in `scripts/compliance-scan.mjs` matches by constant name (`FORBIDDEN\|BLOCKLIST\|DENYLIST…`), so forbidden words inside a similarly named constant are exempted wholesale; and it scans only `.ts` files under `src/` and `scripts/` | `compliance-scan.mjs:168-189,30` | **Positioning clarified**: it is acceptable as a self-review tool, but it must not be presented as independent audit evidence (this audit scanned independently); CI additionally has a "forbidden file names" guard |

### 8.2 Not covered (boundaries that must be communicated to the client)

1. **No dynamic network observation**: no real platform was accessed and no traffic was captured.
   Therefore "at runtime only the gateway address is contacted" cannot be proven empirically (the code
   proves only that the sole egress is `baseUrl`/`eventsUrl`); the effect of DNS resolution, TLS and
   proxy environment variables on the actual egress was not observed either.
2. **The compliance of the EasyBot gateway itself was not verified**: WeChat iLink official
   authorization/QR login, NapCat throwaway-account login, and Telegram Bot API calls and storage all
   happen on the gateway side, not in this repository. If the gateway uses an unofficial iLink channel
   or persists messages, this project cannot detect it. **This may be the largest compliance unknown in
   the whole system.**
3. **Telegram-side actual storage, and the authenticity of the overseas recipient's identity and
   contact details, were not verified**; this project only requires the `receiver.*` fields in the
   configuration.
4. **The current official terms of WeChat iLink (ClawBot) and NapCat were not verified**; the
   descriptions in the documents reflect the time of delivery and the platforms may change.
5. **No end-to-end log capture from a real process**: the basis for acceptance criterion 6 is "code-path
   review + canary assertions in the 59 tests"; no long-running real process with a mock gateway had
   its stdout captured for an independent canary comparison. No memory forensics / core-dump analysis
   was performed (JS runtimes do not guarantee memory zeroization in any case; the documents state this).
6. **The content of files inside `node_modules` and package integrity hashes were not audited**: only
   the lockfile dependency graph and top-level package names were checked. Supply-chain aspects
   (tampered package content, install scripts) were not verified.
7. **No configuration resource-exhaustion testing**: DoS surfaces such as YAML alias bombs,
   over-long configurations and `fieldMap` pointing at deep paths were not tested (the configuration is
   locally controlled input, so the risk is low).
8. **Not verified in a real git repository / CI environment**: the copy had no `.git`, so `npm run check`
   ran locally; whether `.github/workflows/ci.yml` actually passes was not verified, nor was CI's
   "forbidden files" guard (`ci.yml:42-63`, whose `find` explicitly skips `test/fixtures`, i.e. that
   directory could hide `.py`/`.session` files without being detected by that step — the repository
   currently contains no such files).
9. **No substantive legal assessment**: this report does not judge whether a deployment satisfies PIPL
   Articles 38/39/55; it judges only whether the code provides the claimed mechanisms.
10. **Uncovered code branches**: real WS reconnection timing, real gateway 4xx/5xx responses, and
    concurrent consent writes over a long-lived connection (single process, single thread — low risk)
    were not specifically tested.

---

## 9. Remediation log (recorded by the Lead after the audit)

After the audit, the delivering party implemented the recommendations in §8.1 and §9.3. After
remediation `npm run check` is fully green (63/63 tests pass; 4 regression cases added).

| Finding | Resolution | Evidence location |
|---|---|---|
| **F1** domain blocklist bypassable with a trailing dot | **Code fixed**: `hostnameOf()` lower-cases and then strips all trailing dots (`ilinkai.weixin.qq.com.` ≡ `ilinkai.weixin.qq.com`); the document now calls the blocklist "an auxiliary defence to reduce mis-connection, not a security boundary" | `src/compliance/gates.ts › hostnameOf`; regression cases in `test/regression-audit.spec.ts` (3); black-box re-test `direct-ilink-trailing-dot EXIT=78` |
| **F2** consent records unsigned and forgeable | **Not fixed in code — explicitly disclosed** (for a single-machine personal tool, adding signatures would only move the key-management problem onto the local machine) | `COMPLIANCE.md` §6.3 new "consent records can be tampered with locally" row; §10 item 8; `README.md` known limitation 8 |
| **F3 / D1** consent was conversation-granular while the document said "conversation + route" | **Code and document both changed**: `ConsentGrant` gained `routes?: string[]`; `grant()` / `hasGrant()` / `check()` support `routeId`, consent accumulates per route (several third-party routes in one conversation each need their own confirmation); records without `routes` are read as "all routes" (backwards compatible, with a document note to clear and rebuild) | `src/compliance/consent-store.ts › ConsentGrant.routes`; `src/compliance/consent.ts › grant / hasGrant / check`; call sites in `src/pipeline/forward.ts`; regression case F3 (asserts sending only to consented routes); `COMPLIANCE.md` §2.4⑥, §6.2; `docs/CONSENT-FLOW.md` §3, §4 |
| **F4** consent eligibility depends on the gateway's `senderIsSelf`/`senderIsBot` | **Not fixed in code — explicitly disclosed**: the check in `forward.ts::handle` is already tightened to "not self + not bot + private chat", but the field values themselves come from the gateway contract and cannot be verified by the program | `COMPLIANCE.md` §6.3 new row + §10 item 9; `README.md` known limitation 9; `docs/GATEWAY-CONTRACT.md` now requires the gateway to output `sender.isBot` as a mandatory trustworthy field |
| **F5 / D1–D8** 8 documentation inaccuracies | **Corrected item by item**: D1 as above; D2 removed the dead `test/fixtures/config.third-party.yaml` reference in favour of generic instructions; D3 `src/policy/` → `src/routing/`; D4 removed the non-existent "rate limiting" wording; D5 states that the token is read from an environment variable only; D6 explains that logs go to stdout and need manual redirection; D7 states that `.env` is not loaded; D8 states that `messageId` is not in the log whitelist either | `docs/CONSENT-FLOW.md`, `docs/GATEWAY-CONTRACT.md`, `docs/OPERATIONS.md`, `README.md` |
| **F6** group-chat determination depends on the gateway's `chatType` | **Disclosed** (cannot be eliminated in code: this service cannot see the platform's real conversation type) | `COMPLIANCE.md` §6.3 new row; `docs/GATEWAY-CONTRACT.md` §boundary statement 3 |
| **F7** self-declared `contentOwner` can bypass consent | **Disclosed**, raised from "partial statement" to an explicit risk item | `COMPLIANCE.md` §6.3 + §10 item 9; `README.md` known limitation 7 |
| **F8** `loadConfig` created `data/` unconditionally | **Code fixed**: the directory is created only when `thirdPartyConsent.persist === true && enabled === true` (`preflight` tightened accordingly) | `src/config/load.ts`; `src/compliance/preflight.ts` §6 |
| **F9** no git history to verify | **Not handled** (the local copy is not a git repository). `.gitignore` is in place; the delivering party can `git init` and put it under version control | `.gitignore` |
| **F10** `compliance-scan` is a self-review tool | **Positioning clarified**: this report is the independent audit evidence; CI has a separate "forbidden file names" guard | `.github/workflows/ci.yml`; `scripts/compliance-scan.mjs` output already declares its limitations |

### C.1 Re-run results after remediation (executed by the Lead)

```text
npm run check            → exit 0
  tsc --noEmit           → exit 0
  compliance:scan        → exit 0 (23 .ts files, 0 hits, 7 exemptions printed item by item)
  npm test               → 63 tests / 63 pass / 0 fail (new test/regression-audit.spec.ts ×4)

Black-box re-test (cmd /v:on reading real exit codes):
  default-ish                 EXIT=0      # default conservative configuration
  tg-gate-closed              EXIT=78     # cross-border gate fully closed
  tg-ack-incomplete           EXIT=78     # enabled=true but confirmations incomplete
  wechat-group                EXIT=78     # WeChat group-chat source
  third-party-no-consent      EXIT=78     # third-party content + consent off
  direct-ilink-trailing-dot   EXIT=78     # F1 regression: trailing dot no longer bypasses
  direct-ilink                EXIT=78     # direct connection to the official domain
```

### C.2 Items still open (consistent with §8.2)

1. Gateway-side compliance material (iLink authorization method, NapCat account type, Telegram storage
   policy) — outside this repository's control;
2. git history and commit audit — can be supplied on delivery if needed;
3. Dynamic packet-capture observation — this audit performed static + black-box process-level
   verification only;
4. F2/F4/F6/F7 are trust boundaries: they can only be disclosed, not eliminated in code.

**Re-review suggestion:** re-run the 5 black-box configurations from §3 plus the 7 cases in C.1 to
confirm no regression.

---

## 10. Final conclusion

1. **Is the "technical research only, most conservative by default, auditable" delivery standard met?**
   **Essentially yes.** Basis: the default configuration contains only domestic private-chat chains; all
   compliance switches are off by default; dangerous configurations always exit 78 with no bypass
   switch; the logging and persistence surface is narrowed to an allow-list / metadata; the documents
   tie every risk to a code location. Of the 8 acceptance criteria, 5 pass fully and 3 pass with
   reservations.

2. **Blocking issues: none.** None of the following was found: WeChat login bypass, group-chat
   processing, personal-account Telegram, third-party content enabled by default, message content
   entering logs, or content persisted to disk.

3. **Recommended remediation before delivery (by priority)** — all of items 1–4 have since been
   completed (§9):
   1. Fix F1 (hostname normalisation) and correct the absolute statement "preflight necessarily rejects
      ilinkai" in the documents;
   2. Correct the consent-granularity statement in F3/D1 (or change the code granularity), so that
      "notice scope = actual authorization scope" does not drift;
   3. Disclose the four trust boundaries F2/F4/F6/F7 (consent records forgeable, eligibility depends on
      gateway flags, group-chat determination depends on the gateway, `contentOwner` is self-declared);
   4. Correct the 8 documentation inaccuracies in §7.3, especially the dead references D2/D3 and the
      non-existent "rate limiting" D4;
   5. Deliver a repository with git history, and provide gateway-side compliance material (iLink
      authorization method, NapCat account type, Telegram Bot storage policy); otherwise "not covered
      items 1 and 2" in this audit cannot be closed.

4. **Re-review suggestion**: this audit covered all 22 src files and all 59 test cases. After
   remediating F1–F5, re-running the 5 black-box configurations of §3 plus the PoC of §4 is sufficient
   to confirm no regression.

---

*This report was produced by an independent audit session; every conclusion is reproducible with the
commands in §1.2. Line-number references refer to the `D:\openclaw\im-forwarder` working copy as it
stood at the time of the audit.*
