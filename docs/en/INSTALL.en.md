# Install guide (desktop / mobile / build from source)

> **Language / 语言**：[English](INSTALL.en.md) | [简体中文](../INSTALL.md)
>
> ⚠️ **Research and learning only; commercial use is forbidden** (MIT + Commons Clause).
> **All installers are unsigned** — verify `SHA256SUMS.txt` after downloading.
> WeChat: official iLink(ClawBot) private chats only. QQ: NapCat is unofficial, **use a throwaway account**.
> Telegram: official Bot API only, **cross-border forwarding is disabled by default**.

---

## 0. Architecture first: who is the host?

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Desktop (Electron)           │  LAN   │ Mobile (PWA / Android APK)   │
│ · runs the forwarding core   │◀──────▶│ · companion: status / routes │
│ · config, token, logs        │  HTTP  │   / metadata logs / start-stop│
│ · companion server :17871    │        │ · Android: experimental mode │
└──────────────────────────────┘        └──────────────────────────────┘
             │
             ▼  REST + WebSocket (local/LAN EasyBot gateway)
     ┌──────────────────────────────┐
     │ EasyBot unified IM gateway   │── WeChat iLink / QQ NapCat / Telegram Bot API
     └──────────────────────────────┘
```

- The **forwarding core is a long-running process**; it runs on the desktop app (or your own server).
- The **mobile app is a companion**: status, sanitized routes, metadata-only logs, start/stop.
  It does not keep forwarding in the background.
- Android has an extra **experimental "on-device foreground" mode** (§3.7): foreground only,
  text-only, private-chat-only, own routes only.
- **No iOS package is provided**: iOS does not allow a persistent background forwarding process,
  and no Apple signing identity is available.

---

## 1. Windows

| File | Usage |
|---|---|
| `im-forwarder-<version>-win-x64.exe` | NSIS installer; per-user install, no admin required |
| `im-forwarder-<version>-win-x64.zip` | Portable build, unzip and run |

First launch triggers **SmartScreen ("Windows protected your PC")** because the build is unsigned.
Click *More info → Run anyway*. **Verify SHA256 against the release `SHA256SUMS.txt` first.**

After installing:

1. Start im-forwarder (tray icon appears);
2. The first run creates a config and opens the *Config* tab;
3. Enter the **EasyBot gateway URL** and **gateway token** (encrypted at rest, never written to the config file);
4. Click *Validate*, then *Start*;
5. The *Status* tab shows the **companion server address** and a **pairing code** (for mobile).

Uninstall via Settings → Apps. User data (config, consent records, token) lives in
`%APPDATA%\im-forwarder`; delete it manually for a full cleanup.

---

## 2. macOS

| File | Usage |
|---|---|
| `im-forwarder-<version>-mac-universal.dmg` | Intel + Apple Silicon |
| `im-forwarder-<version>-mac-universal.zip` | Unzip to get the `.app` |

Unsigned and not notarized, so Gatekeeper blocks the first launch:

- Option A: right-click the app → *Open* → *Open*;
- Option B:
  ```bash
  xattr -dr com.apple.quarantine /Applications/im-forwarder.app
  ```

If it is still blocked: System Settings → Privacy & Security → *Open Anyway*.
**Do not** disable SIP or lower system-wide security.

User data: `~/Library/Application Support/im-forwarder/`.

---

## 3. Linux

| File | Usage |
|---|---|
| `im-forwarder-<version>-linux-x64.AppImage` | `chmod +x` and run, no install needed |
| `im-forwarder-<version>-linux-x64.deb` | Debian/Ubuntu: `sudo apt install ./im-forwarder-*.deb` |

If AppImage complains about FUSE: `sudo apt install libfuse2`, or run with `--appimage-extract`.

User data: `~/.config/im-forwarder/`.

---

## 3.5 Android APK (sideload)

1. Copy `im-forwarder-<version>-android-debug.apk` to the phone;
2. Settings → Security → allow "install unknown apps" → install;
3. Put the phone and the desktop on the **same LAN**;
4. On the desktop *Status* tab, enable **"Allow LAN access"** (a security warning is shown; confirm),
   then note the address such as `http://192.168.x.x:17871`;
5. Open the app, enter that address, then the 6-digit **pairing code** from the desktop;
6. You can now view status / sanitized routes / metadata logs and **start or stop** forwarding.
   Config editing stays desktop-only.

> If it cannot connect: same subnet? Windows firewall allows 17871? LAN toggle on?
> **Never expose this port to the public internet**; for remote access use a VPN and assess the risk yourself.

### 3.6 Mobile: PWA (also works on iOS)

1. Open `http://<desktop-ip>:17871/` in the phone browser;
2. iOS Safari: Share → *Add to Home Screen*; Android Chrome: menu → *Install app* / *Add to Home Screen*;
3. Pair exactly as above.

The PWA and the APK share the same UI; the APK only adds the *Experimental mode* entry.

### 3.7 Android experimental mode: on-device foreground forwarding (off by default)

Purpose: run a restricted forwarding loop on the phone when no desktop host is available.

- Allowed: **text**, **private chats**, `contentOwner=self`, **WeChat ↔ QQ** routes only;
- Refused: Telegram cross-border routes, third-party content, group chats, any media;
- **Foreground only**: screen lock / backgrounding / incoming call stops it immediately;
- Gateway token lives in memory only; no content or logs are persisted;
- Talking to the gateway directly requires the gateway to allow CORS (WebView origin `http://localhost`);
  if blocked, the app tells you to use companion mode instead.

**Do not** rely on this for anything important: mobile OS lifecycle management will kill it.

### 3.8 iOS

**No IPA is provided.** Reasons:

1. iOS does not allow a third-party app to keep a forwarding process alive in the background
   (`BGAppRefreshTask` cannot hold a WebSocket);
2. There is no Apple developer account / signing identity to produce an installable IPA;
3. App Store review rejects message-automation forwarding apps, and sideloading requires self-signing tools.

Alternative: use the **PWA companion** via Safari *Add to Home Screen* (§3.6); the core still runs
on the desktop.

If you do have macOS + Xcode + an Apple account, you can build it yourself:

```bash
cd apps/mobile
npm ci
npm run sync
npx cap open ios          # requires macOS + Xcode
# set Team / Bundle ID in Xcode, then Run or Archive
```

`apps/mobile/ios/README.md` documents the skeleton status and caveats.

---

## 4. Build from source

### 4.1 Desktop

```bash
# core dependencies are needed to bundle the core
npm ci

cd apps/desktop
npm ci
npm run typecheck
npm run build          # dist/core-runner.cjs + build/icon.png
npm run start          # dev run
npm run smoke          # headless config + preflight check (exit 0/78)
npm run dist:win       # Windows only
npm run dist:mac       # macOS only (universal)
npm run dist:linux     # Linux (or the CI ubuntu runner)
```

Artifacts go to `apps/desktop/release/`.

### 4.2 Mobile web / APK

```bash
cd apps/companion-web
npm ci
npm run typecheck && npm test
npm run build          # dist/ (PWA)

cd ../mobile
npm ci
npm run sync           # build web + cap sync
# Android (JDK 17 + Android SDK):
cd android && ./gradlew assembleDebug
# output: app/build/outputs/apk/debug/app-debug.apk
```

iOS builds require macOS + Xcode (see §3.8).

### 4.3 One-click release (GitHub Actions)

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds:

- Windows: NSIS + portable
- macOS: universal dmg + zip (unsigned)
- Linux: AppImage + deb
- Android: debug APK (sideload)
- `SHA256SUMS.txt` and a GitHub Release with all assets

---

## 5. Verify downloads (strongly recommended)

```bash
# Linux / macOS
sha256sum -c SHA256SUMS.txt

# Windows PowerShell
Get-Content SHA256SUMS.txt | ForEach-Object { $h,$f = $_ -split '\s+',2; (Get-FileHash $f -Algorithm SHA256).Hash -eq $h }
```

If verification fails, **do not install** — the download was tampered with or corrupted.

---

## 6. Security and compliance notes

1. **Unsigned**: Windows/macOS will warn; Android uses a debug key, suitable for personal sideloading only;
2. **LAN exposure**: the companion server listens on `127.0.0.1` by default. Enabling LAN access exposes it
   to the same subnet — use trusted networks only and rotate the pairing token regularly;
3. **Token**: encrypted on the desktop or provided via environment variable; never screenshot or share it;
4. **NapCat**: throwaway account only, ban risk is yours; **Telegram**: cross-border transfer is off by
   default and requires the legal formalities before enabling;
5. This project **provides no circumvention of network restrictions** and accepts no liability for account
   safety or data leaks.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Blank window on first launch | Wait 2–3 s; if it persists, open the desktop *Logs* tab (metadata only, never written to disk) |
| *Validate* reports `CROSS_BORDER_*` | A Telegram target exists but the cross-border gate is closed; remove the route or complete the four confirmations |
| *Validate* reports `THIRD_PARTY_*` | Third-party route lacks the consent mechanism or notice fields; see COMPLIANCE.md |
| Phone cannot connect | Same subnet? LAN toggle on? firewall 17871? pairing code expired (10 min)? |
| Antivirus blocks the installer | Unsigned build; verify SHA256, whitelist it, or use the portable zip |
| macOS "app is damaged" | `xattr -dr com.apple.quarantine /Applications/im-forwarder.app` |
| Android refuses to install | Allow unknown sources; some vendors also require disabling "pure mode" |
| Port 17871 already in use | Change the port in desktop settings and update the phone address |

---

## 8. Feedback and contact

- Bugs / feature requests: [GitHub Issues](https://github.com/DaiYiqq/im-forwarder/issues)
- Security issues: see [SECURITY.md](../../SECURITY.md) (private report; do not open a public issue)
- Maintainer: 戴亿 (DaiYi) · [@DaiYiqq](https://github.com/DaiYiqq) · 1703205607@qq.com ·
  daiy91004@gmail.com · QQ 1703205607 · WeChat daiyi091004 · Douyin daiyi091004
