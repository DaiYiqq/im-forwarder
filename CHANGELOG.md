# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

> Reminder: this project is **non-commercial**. See [LICENSE](LICENSE).

## [Unreleased]

### Added
- Static online demo (GitHub Pages) at <https://daiyiqq.github.io/im-forwarder/>: compliance-gate
  decision chain, cross-border gate playground, routing matrix and a mock companion console.
  Pure front-end, no backend, no network calls, no data collection; CI enforces these properties
  and runs the policy-mirror self-test before deploying.

### Fixed
- Release pipeline publishes only installer artifacts (no unpacked application trees) and writes
  `SHA256SUMS.txt` over top-level files; the published `v0.2.0` assets were corrected accordingly.

### Planned
- Optional plain-text prefix per route (opt-in, off by default) — pending RFC.
- Additional languages (한국어 / Deutsch / Español) — see [TRANSLATIONS.md](TRANSLATIONS.md).
- Code signing for Windows/macOS deliverables (currently unsigned, see docs/INSTALL.md).

## [0.2.0] - 2026-10-20

Desktop installers for Windows/macOS/Linux, a mobile companion app (PWA + Android APK),
an experimental on-device foreground mode for Android, and the four-language documentation set.

### Added
- **Desktop app** (`apps/desktop`, Electron): tray-resident host that runs the existing core in a
  sandboxed `utilityProcess`, with a configuration editor (strict schema + preflight validation),
  status/logs/compliance panels, encrypted token storage via `safeStorage`, and no message content
  anywhere in the UI.
- **Companion HTTP API** (desktop, default `127.0.0.1:17871`): pairing code → bearer token,
  `status / control / routes (sanitized) / logs (whitelisted metadata)`; LAN mode is opt-in and
  clearly warned; config editing stays desktop-only.
- **Mobile companion** (`apps/companion-web`): shared PWA served by the desktop app
  ("add to home screen"), plus an Android WebView shell (`apps/mobile`, Capacitor).
- **Android experimental on-device mode**: foreground-only forwarding in the WebView, restricted to
  text-only, private-chat-only, self-owned WeChat↔QQ routes; refuses Telegram/third-party/group/media;
  stops immediately on backgrounding; gateway token kept in memory only.
- **iOS project skeleton** (`apps/mobile/ios`) with build instructions; no IPA is published
  (iOS cannot run a persistent forwarding daemon and no Apple signing identity is available).
- **Release pipeline** (`.github/workflows/release.yml`): Windows NSIS + portable, macOS universal
  dmg + zip, Linux AppImage + deb, Android debug APK, `SHA256SUMS.txt`, GitHub Release on `v*` tags.
- `docs/INSTALL.md` / `docs/en/INSTALL.en.md`: install, first-run, unsigned-build guidance,
  mobile pairing, Android sideload, iOS build notes, uninstall.

### Documentation & governance
- `README.md` is now **Simplified Chinese** (canonical, GitHub default); English moved to
  `README.en.md`; `README.zh-CN.md` removed; **繁體中文 added** (`README.zh-TW.md`) as the fourth language.
- English translations of the long-form documents in `docs/en/` (`COMPLIANCE`, `ROUTING`,
  `GATEWAY-CONTRACT`, `CONSENT-FLOW`, `OPERATIONS`) plus an English audit summary (`AUDIT.en.md`);
  Chinese originals carry bilingual headers.
- GitHub Discussions, branch protection (required CI check, 1 review, linear history,
  no force-push/deletion) and private vulnerability reporting enabled.
- `TRANSLATIONS.md`, `GOVERNANCE.md`, `CONTRIBUTING.md` updated for the new canonical language.

### Changed
- Root `package.json` version `0.2.0`; new `app:*` scripts delegate to per-app projects
  (apps are independent npm projects, not workspaces, so the core dependency allow-list is unchanged).
- Test runner now also collects `apps/companion-web/test/*.spec.ts`.

### Compliance
- Desktop/mobile surfaces add no new platform capabilities: no logins, no userbots, no group chats,
  no media parsing, no content persistence. Companion API exposes only metadata and control actions.
- Mobile experimental mode is deliberately a **subset** (no Telegram, no third-party content),
  so its narrower scope is stricter than the desktop core.

### Release
- GitHub Release `v0.2.0` published with seven unsigned installers (Windows NSIS + portable,
  macOS universal dmg + zip, Linux AppImage + deb, Android debug APK) plus `SHA256SUMS.txt`.
- Release pipeline publishes only final installers, asserts the expected artifact count, and
  generates checksums over top-level files only (no unpacked application trees).

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
