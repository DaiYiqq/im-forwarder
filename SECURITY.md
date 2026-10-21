# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ (current) |

Pre-1.0 releases are maintained on a best-effort basis. Always run the latest `main` with a green
`npm run check`.

## Report a vulnerability privately

**Do not open a public issue for security problems.**

- **Email:** 1703205607@qq.com or daiy91004@gmail.com
  (subject prefix: `[SECURITY] im-forwarder`)
- **GitHub:** use *Security → Report a vulnerability* (private advisory) if enabled on this repo,
  or DM [@DaiYiqq](https://github.com/DaiYiqq).
- Alternatively, open a public issue **only** if the report contains no exploit details and no
  sensitive data, and say that you have a private report pending.

Please include:

- affected version / commit hash;
- a minimal reproduction (config shape + sequence of events; **no real chat content**);
- impact assessment: what an attacker gains (e.g. token exfiltration, gate bypass, log leakage);
- suggested fix if you have one.

**Expected timeline** (best effort, no SLA): acknowledgement within 7 days, triage within 14 days,
fix or mitigation plan within 30 days for confirmed issues. Credit is given in the changelog unless
you prefer to stay anonymous.

## Scope

In scope (this repository):

- bypassing compliance gates: cross-border gate, group-chat gate, consent gate, loop guard;
- leaking message content into logs, error messages, crash output or any persisted file;
- SSRF / credential leakage in `src/gateway/*` (e.g. the gateway token sent to an unexpected host);
- denial of service through message processing (unbounded memory, infinite loop);
- supply-chain issues in the build/test scripts.

Out of scope:

- the **EasyBot gateway** itself (its login, adapters, storage) — report to that project;
- WeChat / QQ / Telegram platform vulnerabilities;
- account bans caused by using NapCat (documented, expected risk);
- anything requiring the attacker to already have full local write access
  (see *Trust boundaries* below).

## Known trust boundaries (not vulnerabilities)

These are documented limitations, not bugs. Reports about them will be closed with a pointer to
[COMPLIANCE.md](COMPLIANCE.md) §6.3 / §10:

1. `data/consent.json` is an unsigned local file — whoever can write it can forge consent.
2. `contentOwner` is self-declared; labelling someone else's chat as `self` bypasses consent.
3. `chatType`, `senderIsSelf`, `senderIsBot` come from the gateway; misreporting breaks the gates.
4. Message content is not memory-zeroized (JS runtime limitation).
5. The project is not a compliance guarantee; it is a technical control.

## What we will never accept as a "fix"

- adding platform logins, QR flows, cookies, web/iPad protocols, hooks or reverse-engineered clients;
- adding Telegram userbot / MTProto / Telethon / Pyrogram;
- enabling group chats (any platform) or media download/parsing;
- persisting message content or logging it;
- adding any `--force` / `--skip-compliance` bypass, or an environment variable that does the same;
- adding proxy/tunnel/circumvention code;
- loosening the non-commercial restriction in [LICENSE](LICENSE).

## Abuse reports

If you find someone using this project for non-consensual forwarding, paid services or other
unlawful processing, open a *compliance concern* issue (template provided) or email the maintainer.
**Do not attach the actual chat content.** We can only act on this repository and its documentation;
we cannot police third-party deployments.

## Hardening suggestions for operators

- keep the gateway on `127.0.0.1` or a private network; never expose its token;
- run the service as a non-privileged user; restrict write access to `data/`;
- keep `logLevel: info` (debug adds nothing but noise — content never appears either way);
- back up `data/consent.json` (metadata only) and review it periodically;
- pin dependencies (`package-lock.json`) and run `npm run check` before every deploy.

---

## 中文摘要

- 支持版本：0.1.x（尽力维护，无 SLA）。
- **漏洞请私下报告**：1703205607@qq.com / daiy91004@gmail.com，或使用 GitHub 私密安全通告。
  不要开公开 Issue 贴利用细节。
- 报告内容需含：版本、最小复现（**不含真实聊天内容**）、影响评估、可选修复建议。
- 期望时限：7 天内确认、14 天内分级、确认问题 30 天内给出修复或缓解方案（尽力而为）。
- 责任范围：只覆盖本仓库（合规闸门绕过、正文泄漏、网关令牌外发、DoS、供应链）；
  **不覆盖** EasyBot 网关自身、平台漏洞、NapCat 封号（属已知风险）。
- "信任边界"不是漏洞：同意记录可伪造、`contentOwner` 自述、网关字段可信性、内存无法清零，
  详见 [COMPLIANCE.md](COMPLIANCE.md) §6.3 / §10。
- 永不接受的"修复"：新增平台登录/userbot/群聊/媒体解析/正文持久化/合规绕过开关/规避网络方案/
  放宽非商业限制。

---

## Distribution, desktop and mobile (v0.2.0)

### Artifacts are unsigned

- Windows (NSIS/portable), macOS (dmg/zip) and Android (debug APK) artifacts are **not signed** by a
  trusted publisher. Verify `SHA256SUMS.txt` from the release page before installing; do not install
  packages obtained from third-party sites.
- There is **no auto-update mechanism** and **no telemetry/crash reporting**. Updates are manual
  downloads from GitHub Releases.
- iOS: no IPA is published (no signing identity; iOS does not permit persistent background forwarding).

### Companion API threat model (desktop → phone)

- Default bind: `127.0.0.1:17871`. LAN binding is an explicit, warned opt-in.
- Auth: 6-digit pairing code (10 minutes, single use, 5 failures/min/IP) exchanged for a bearer token;
  token comparison is constant-time; all responses are `no-store`.
- Exposed data: runtime status, **sanitized** routes (no conversation IDs or receiver details),
  whitelisted log fields, start/stop control. Never: message content, raw gateway frames,
  plaintext config, tokens.
- Transport is plain HTTP on the LAN by default (no TLS). Treat the local network as the trust
  boundary; use a VPN for remote access. Do not port-forward 17871 to the internet.
- If a paired device is lost, use "reset pairing token" on the desktop; all devices must re-pair.

### Out of scope for reports

- Someone with local write access to the desktop profile can modify config/consent (documented trust boundary).
- Network attackers on an untrusted LAN (no TLS) — use a trusted network/VPN.
- Android OS killing the experimental foreground mode (documented limitation, not a vulnerability).

### Mobile

- Android APK is a **debug-signed sideload** build; it is not distributed via app stores.
- The experimental on-device mode is a strict subset (no Telegram, no third-party content, no groups,
  no media, foreground only). Reports about "it stops in the background" are expected behaviour.

### Demo site (GitHub Pages)

- The online demo at <https://daiyiqq.github.io/im-forwarder/> is **static**: no backend, no network
  requests (CI greps for `fetch(` / `XMLHttpRequest` / `WebSocket(`), no credentials, no analytics,
  no storage of visitor input.
- Hosting is provided by GitHub Pages; the project adds no tracking of its own. Hosting-platform
  issues belong to GitHub.
- Out of scope by design: anything that would require the demo to actually forward messages.
