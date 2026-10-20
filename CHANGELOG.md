# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

> Reminder: this project is **non-commercial**. See [LICENSE](LICENSE).

## [Unreleased]

### Added
- 繁體中文 README (`README.zh-TW.md`) — fourth language (community-maintained).
- English translations of the long-form documents in `docs/en/`: `COMPLIANCE.en.md`,
  `ROUTING.en.md`, `GATEWAY-CONTRACT.en.md`, `CONSENT-FLOW.en.md`, `OPERATIONS.en.md`,
  plus an English audit summary (`AUDIT.en.md`).
- Repository governance: GitHub Discussions, branch protection (required CI check
  `typecheck / compliance-scan / test`, 1 approving review, linear history, no force-push/deletion),
  private vulnerability reporting.

### Changed
- `README.md` is now **Simplified Chinese** (canonical, and the version GitHub displays).
  English moved to `README.en.md`; `README.zh-CN.md` was removed.
- `TRANSLATIONS.md`, `GOVERNANCE.md` and `CONTRIBUTING.md` updated for the new canonical language
  (Simplified Chinese) and the four-language layout.
- Chinese long-form docs now carry a bilingual header linking to their English translations.

### Planned
- Optional plain-text prefix per route (opt-in, off by default) — pending RFC.
- Additional languages (한국어 / Deutsch / Español) — see [TRANSLATIONS.md](TRANSLATIONS.md).

## [0.1.0] - 2026-10-18

First public release. Scope is deliberately narrow: **text-only, private-chat-only,
gateway-only, default-off compliance gates**.

### Added
- Three-platform routing matrix through the EasyBot gateway:
  `source platform:conversation → target platform:conversation`, any pair, no pairwise hard-coding.
- Runtime policy chain: self/bot filter → group-chat hard gate → route resolution → echo/hop guard →
  text-only gate → cross-border gate → fingerprint loop guard → consent gate → forward.
- Loop protection in three layers: echo `messageId`, short-lived HMAC content fingerprint
  (memory only), hop budget (`maxHops`, default 1).
- Cross-border (Telegram) gate: default off; requires `enabled` + `operator` + `acknowledgedAt` +
  `selfMessagesOnlyConfirmed` + matching risk-notice version; otherwise the process refuses to start.
- Notice-and-consent flow for other people's content (PIPL Art. 23): notice with receiver name,
  contact, purpose, method, data categories and retention; per-route consent; recall (`撤回同意`);
  TTL; metadata-only storage in `data/consent.json`.
- Separate cross-border consent (PIPL Art. 39) for third-party content chains that leave the country
  (disabled by default via `allowCrossBorder: false`).
- Whitelisted logging: `ts/level/event/routeId/sourcePlatform/targetPlatform/status/errorCode/...`;
  over-long values replaced with `[omitted:N]`; no message content, no conversation IDs.
- `--self-check` mode: config + compliance validation with exit code 78 and per-item remediation hints;
  no bypass flag exists.
- Local mock gateway and end-to-end tests without any real platform connection.
- Static compliance scan (`npm run compliance:scan`): comment stripping, forbidden-word list,
  `console.log` check, exact dependency allow-list.
- CI: typecheck → compliance scan → acceptance guard (forbidden files) → full test suite.
- Documentation: README (EN/zh-CN/ja), COMPLIANCE.md (article → code location), ROUTING.md,
  GATEWAY-CONTRACT.md, CONSENT-FLOW.md, OPERATIONS.md, independent audit report (AUDIT.md).
- Community files: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, GOVERNANCE, TRANSLATIONS, CONTACT.

### Compliance / Security
- No WeChat login, QR, cookie, web-protocol, iPad-protocol, hook or reverse-engineering code.
- No MTProto / userbot / Telethon / Pyrogram code paths; Telegram is official Bot API only.
- Group chats rejected for **all** platforms at compile time and runtime, with no enabling switch.
- No message-content persistence; no content in logs; no media download or parsing.
- Platform endpoints are blocked as gateway targets (hostname normalized, including trailing dots).
- Remediated findings from the independent audit: trailing-dot domain bypass, consent granularity
  (now per route), and eight documentation inaccuracies.

### Known limitations
- Gateway contract is defined by this project and must be verified against a real gateway;
- `contentOwner`, `chatType`, `senderIsSelf`, `senderIsBot` are trust boundaries;
- consent records are unsigned local files (internal credibility only);
- no memory zeroization guarantee (JS runtime);
- group chats and media are intentionally unsupported.

### License
- MIT + Commons Clause (non-commercial): no selling, no paid hosting, no resale.

[Unreleased]: https://github.com/DaiYiqq/im-forwarder/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DaiYiqq/im-forwarder/releases/tag/v0.1.0
