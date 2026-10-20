# 安装指南（桌面端 / 移动端 / 源码构建）

> **语言 / Language**：[简体中文](INSTALL.md) | [English](en/INSTALL.en.md)
>
> ⚠️ 本项目**仅供技术研究学习，禁止商业用途**（MIT + Commons Clause）。
> 所有安装包**未签名**，下载后请核对 `SHA256SUMS.txt`。
> 微信侧仅官方 iLink(ClawBot) 且仅私聊；QQ 侧 NapCat 非官方通道，**必须用小号**；
> Telegram 仅官方 Bot API，**出境转发默认关闭**。

---

## 0. 先理解架构：谁是"宿主"

```
┌──────────────────────────┐        ┌───────────────────────────┐
│ 桌面端（Electron）        │  LAN   │ 手机端（PWA / Android APK）│
│ · 运行转发核心（宿主）    │◀──────▶│ · 伴生控制端：状态/路由/   │
│ · 配置、令牌、日志        │  HTTP  │   日志、启停（只读配置）   │
│ · 伴生服务 :17871         │        │ · Android 另有实验模式     │
└──────────────────────────┘        └───────────────────────────┘
             │
             ▼  REST + WebSocket（本机/内网 EasyBot 网关）
     ┌──────────────────────────┐
     │ EasyBot 统一 IM 网关      │── 微信 iLink / QQ NapCat / Telegram Bot API
     └──────────────────────────┘
```

- **转发核心是常驻进程**，运行在桌面端（或你自己的服务器上）；
- **手机端是伴生控制端**：查看状态、脱敏路由、元数据日志，启停转发。手机不承担常驻转发；
- Android 另有**实验性"本机前台转发"**模式（仅前台、仅文本、仅私聊、仅本人路由，详见 §3.3）；
- **iOS 不提供安装包**：iOS 不允许常驻后台转发进程，且无 Apple 签名身份。

---

## 1. Windows

| 文件 | 用法 |
|---|---|
| `im-forwarder-<版本>-win-x64.exe` | NSIS 安装器，双击安装（默认安装到当前用户目录，无需管理员） |
| `im-forwarder-<版本>-win-x64-portable.exe` | 便携版，双击即用，适合 U 盘/免安装 |

首次运行会提示 **"Windows 已保护你的电脑"（SmartScreen）**：因为安装包未签名。
点「更多信息」→「仍要运行」。**请先确认 SHA256 与 Release 页的 `SHA256SUMS.txt` 一致**。

安装后：

1. 启动 im-forwarder（托盘出现图标）；
2. 首次启动会生成配置并打开「配置」页；
3. 填写 **EasyBot 网关地址** 与 **网关令牌**（令牌加密存储，不写入配置文件）；
4. 点「校验」，通过后点「启动」；
5. 「状态」页会显示**伴生服务地址**与**配对码**（手机端配对用）。

卸载：Windows 设置 → 应用 → 卸载。用户数据（配置、同意记录、令牌）位于
`%APPDATA%\im-forwarder`，需要彻底清理请手动删除。

---

## 2. macOS

| 文件 | 用法 |
|---|---|
| `im-forwarder-<版本>-mac-universal.dmg` | 同时支持 Intel 与 Apple Silicon |
| `im-forwarder-<版本>-mac-universal.zip` | 解压后得到 `.app` |

未签名 + 未公证（no notarization），首次打开会被 Gatekeeper 拦截：

- 方式 A：右键 App →「打开」→「打开」；
- 方式 B：
  ```bash
  xattr -dr com.apple.quarantine /Applications/im-forwarder.app
  ```

仍被拦截时：系统设置 → 隐私与安全性 → 仍要打开。**不要**关闭 SIP 或全局降低安全性。

用户数据：`~/Library/Application Support/im-forwarder/`。

---

## 3. Linux

| 文件 | 用法 |
|---|---|
| `im-forwarder-<版本>-linux-x86_64.AppImage` | `chmod +x` 后直接运行，无需安装 |
| `im-forwarder-<版本>-linux-amd64.deb` | Debian/Ubuntu：`sudo apt install ./im-forwarder-*.deb` |

AppImage 若提示缺少 FUSE：`sudo apt install libfuse2`，或 `./im-forwarder-*.AppImage --appimage-extract` 后运行。

用户数据：`~/.config/im-forwarder/`。

---

## 3.5 移动端：Android APK（侧载）

1. 把 `im-forwarder-<版本>-android-debug.apk` 传到手机（数据线/网盘/局域网）；
2. 设置 → 安全 → 允许「安装未知来源应用」→ 安装；
3. 手机与桌面端**连接同一局域网**；
4. 桌面端「状态」页打开**「允许局域网访问」**（会显示安全警告，确认后生效），
   记下形如 `http://192.168.x.x:17871` 的地址；
5. 手机 App 打开后填入该地址 → 输入桌面端显示的 6 位**配对码** → 连接；
6. 连接成功后可查看状态/脱敏路由/元数据日志，并可**启动/停止**转发（配置编辑仅桌面端可用）。

> 若连接失败：确认同一网段、Windows 防火墙允许 17871、桌面端局域网开关已开启。
> **不要把该端口暴露到公网**；需要远程访问请使用 VPN/内网穿透并自行评估风险。

### 3.6 移动端：PWA（iOS 也可用）

1. 手机浏览器打开桌面端显示的地址 `http://<桌面IP>:17871/`；
2. iOS Safari：分享 →「添加到主屏幕」；Android Chrome：菜单 →「安装应用」/「添加到主屏幕」；
3. 之后从桌面图标打开，配对方式同上。

PWA 与 APK 是同一套界面；差异仅在 APK 多一个「实验模式」入口。

### 3.7 Android 实验模式：本机前台转发（默认关闭）

用途：在**没有桌面宿主**时，临时用手机前台跑一个受限转发循环。

- 仅支持：**文本**、**私聊**、`contentOwner=self` 的 **微信 ↔ QQ** 路由；
- **拒绝**：Telegram 出境路由、他人内容（third-party）、群聊、任何媒体；
- **仅前台**：锁屏 / 切后台 / 来电即停止；不会在后台偷偷运行；
- 网关令牌只存内存，退出即失效；不持久化任何正文与日志；
- 直连网关需要网关允许 CORS（WebView 来源为 `http://localhost`），失败时会提示改用伴生模式。

**不建议**把它用于重要场景：移动 OS 的生命周期管理会随时终止它。

### 3.8 iOS

**不提供 IPA**。原因：

1. iOS 不允许第三方应用常驻后台运行转发进程（`BGAppRefreshTask` 无法维持 WebSocket 长连接）；
2. 没有 Apple 开发者账号与签名身份，无法产出可安装的 IPA；
3. App Store 审核会拒绝此类"消息自动化转发"应用，侧载又需要自签工具。

可用替代：Safari「添加到主屏幕」使用 **PWA 控制端**（§3.6），转发核心仍跑在桌面端。

如你有 macOS + Xcode + Apple 账号，可自行构建：

```bash
cd apps/mobile
npm ci
npm run sync
npx cap open ios          # 需要 macOS + Xcode
# 在 Xcode 中配置 Team/Bundle ID 后 Run 或 Archive
```

`apps/mobile/ios/README.md` 记录了工程骨架状态与注意事项。

---

## 4. 从源码构建

### 4.1 桌面端

```bash
# 先在仓库根目录安装核心依赖（构建 core bundle 需要）
npm ci

cd apps/desktop
npm ci
npm run typecheck
npm run build          # 产出 dist/core-runner.cjs + build/icon.png
npm run start          # 开发运行
npm run smoke          # 无界面校验配置与合规前置检查（0/78）
npm run dist:win       # 仅 Windows 可跑
npm run dist:mac       # 仅 macOS 可跑（universal）
npm run dist:linux     # Linux（或 CI 的 ubuntu runner）
```

产物在 `apps/desktop/release/`。

### 4.2 移动端 Web / APK

```bash
cd apps/companion-web
npm ci
npm run typecheck && npm test
npm run build          # 产出 dist/（PWA）

cd ../mobile
npm ci
npm run sync           # 构建 web + cap sync
# Android（需 JDK 17 + Android SDK）：
cd android && ./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

iOS 构建需 macOS + Xcode（见 §3.8）。

### 4.3 一键发布（GitHub Actions）

推送 `v*` tag 会触发 `.github/workflows/release.yml`，自动构建：

- Windows：NSIS + portable
- macOS：universal dmg + zip（未签名）
- Linux：AppImage + deb
- Android：debug APK（侧载）
- 汇总 `SHA256SUMS.txt` 并创建 GitHub Release

---

## 5. 校验下载文件（强烈建议）

```bash
# Linux / macOS
sha256sum -c SHA256SUMS.txt

# Windows PowerShell
Get-Content SHA256SUMS.txt | ForEach-Object { $h,$f = $_ -split '\s+',2; (Get-FileHash $f -Algorithm SHA256).Hash -eq $h }
```

校验不通过**不要安装**：说明下载被篡改或中断。

---

## 6. 安全与合规提醒

1. **未签名**：Windows/macOS 会警告；Android 为 debug 签名，仅适合侧载自用；
2. **局域网暴露**：伴生服务默认只监听 `127.0.0.1`；开启局域网后同网段设备可访问，
   请仅在可信网络使用，并定期在桌面端「重置配对码/令牌」；
3. **令牌**：只在桌面端加密存储或环境变量；不要截图、不要发群；
4. **NapCat**：必须用小号，封号风险自担；**Telegram**：出境默认关闭，开启需完成法定程序；
5. 本项目**不提供任何规避性网络方案**，也不对账号安全、数据泄露承担责任。

---

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| 首次启动白屏 | 等待 2–3 秒；若持续，打开桌面端「日志」面板（仅元数据，不落盘） |
| 「校验」报 `CROSS_BORDER_*` | 配置里有 Telegram 目标但出境闸门没开；按提示删除该路由或补齐四要素 |
| 「校验」报 `THIRD_PARTY_*` | 他人内容路由缺少同意机制或告知要素；见 COMPLIANCE.md |
| 手机连不上 | 同网段？桌面局域网开关已开？防火墙 17871？配对码是否过期（10 分钟） |
| 安装被杀毒软件拦截 | 未签名所致；核对 SHA256 后加白名单，或改用 portable 版 |
| macOS「已损坏，无法打开」 | `xattr -dr com.apple.quarantine /Applications/im-forwarder.app` |
| Android 安装被拒 | 允许未知来源；部分厂商需关闭「纯净模式」 |
| 端口 17871 被占用 | 桌面端设置里改端口，手机端同步修改地址 |

---

## 8. 反馈与联系

- Bug / 功能建议：[GitHub Issues](https://github.com/DaiYiqq/im-forwarder/issues)
- 安全漏洞：见 [SECURITY.md](../SECURITY.md)（私密报告，勿公开）
- 开发者：戴亿（DaiYi）· [@DaiYiqq](https://github.com/DaiYiqq) · 1703205607@qq.com ·
  daiy91004@gmail.com · QQ 1703205607 · 微信 daiyi091004 · 抖音 daiyi091004
