# im-forwarder 桌面端（Electron）

微信(iLink/ClawBot) ↔ QQ(NapCat) ↔ Telegram(Bot API) 转发路由服务的**桌面外壳**。
托盘常驻、配置编辑与前置校验、状态/日志/合规面板，内置核心转发进程，并提供供手机
PWA/APK 使用的**移动伴生控制 API**。

> 仅限技术研究学习。禁止商业用途 / 收费服务 / 付费托管。使用前请完整阅读仓库根目录的
> `README.md`、`COMPLIANCE.md`、`SECURITY.md` 与 `LICENSE`。

---

## 1. 目录与构建产物

```
apps/desktop/
├─ package.json                 # 脚本入口（版本 0.2.0）
├─ tsconfig.json
├─ electron-builder.yml         # 未签名构建：无 publish / 无 autoUpdater
├─ scripts/
│  ├─ build-core.mjs            # esbuild：核心→CJS、主进程、preload、preflight、伴生服务
│  ├─ make-icon.mjs             # 纯 Node 手写 PNG（512×512，无图像库）
│  └─ companion-smoke.mjs       # 伴生 API 无界面全链路自测
├─ build/icon.png               # 由 make-icon 生成（托盘/窗口/安装包图标）
├─ src/
│  ├─ main.ts                   # 主进程：单实例/托盘/窗口/IPC/核心进程/伴生服务/日志缓冲
│  ├─ preload.ts                # contextBridge 白名单 API（无 nodeIntegration）
│  ├─ core-runner.ts            # utilityProcess 入口（复用 ../../src 核心）
│  ├─ ipc.ts                    # 主进程↔渲染进程消息类型与日志白名单投影
│  ├─ preflight.ts              # 主进程复用核心 loadConfig/runPreflight 的入口
│  └─ companion/
│     ├─ server.ts              # 伴生 HTTP API（可独立 node 运行）
│     └─ auth.ts                # 配对码/令牌/恒定时间比较/限流
├─ renderer/                    # 原生 HTML/CSS/JS（无框架）
└─ dist/                        # 构建产物（core-runner/main/preload/preflight/companion-server）
```

### 构建命令

```powershell
cd apps/desktop
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"                    # 国内网络可选
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install
npm run typecheck
npm run build          # = icon + build:core
npm run start          # 开发态启动（会先 build）
npm run smoke          # 无窗口 CI 自检（退出码 0/78/1）
npm run dist:win       # release/：NSIS 安装包 + portable exe
npm run dist:mac       # release/：dmg + zip（universal，需在 macOS 上构建）
npm run dist:linux     # release/：AppImage + deb
```

`npm run build` 会先触发 `prebuild` 构建 `apps/companion-web`（移动端静态资源）。
CI 里请先构建 companion-web 再构建桌面端；若未构建，伴生服务的 `/` 会返回
**503 + 明确提示**，API 仍可用，不会崩溃。

---

## 2. 运行时行为

* 首次启动：`userData/config.yaml` 不存在时，从安装包内
  `resources/config/config.example.yaml` 复制一份（绝不覆盖已有配置）。
* 也可以设置 `IM_CONFIG_PATH=<绝对路径>` 覆盖配置路径（CI/smoke 用）。
* 配置保存前：主进程调用核心 `loadConfig`（危险键扫描 + strict schema）与
  `runPreflight`（合规硬闸）。**存在违规只报错、不自动修正、不提供任何绕过开关**。
* 启动核心：`utilityProcess.fork(dist/core-runner.cjs)`，通过 `process.parentPort`
  双向通信；子进程发 `status/log/fatal`，父进程发 `stop`。
* 关闭窗口 = 最小化到托盘；托盘菜单：显示/隐藏、启动/停止、退出。
* 退出码约定（与核心 CLI 一致）：`0` 正常、`78` 配置/合规检查未通过、`1` 运行期异常。

### `--smoke`（CI 用）

```powershell
$env:IM_CONFIG_PATH="C:\temp\cfg-ok.yaml"   # 绝对路径；未设置时用 userData/config.yaml
$env:EASYBOT_TOKEN="<网关令牌>"              # 正例必须设置；缺失时 preflight 会给出 78
npm run smoke
```

* 不创建窗口、不建托盘、不启动伴生 HTTP 服务、不连接网关；
* 退出码：配置与 preflight 通过 → `0`；任一违规 → `78`；意外异常 → `1`；
* 含 Telegram 目标路由但出境闸门未开 → `78`（`CROSS_BORDER_GATE_CLOSED`）。

---

## 3. 安全与合规设计（逐条对应红线）

| 红线 | 实现 |
| --- | --- |
| 不显示/缓存/记录消息正文 | 核心 `Logger` 类型+运行期双白名单；桌面端再投影为 9 字段（`ts/level/event/routeId/sourcePlatform/targetPlatform/status/errorCode/latencyMs`）；日志仅内存环形缓冲（≤1000 条），不落盘；渲染进程与伴生 API 共用同一份白名单记录 |
| 不新增平台登录/扫码/Cookie/userbot/群聊/媒体能力 | 桌面端不 import 任何平台 SDK；核心复用 `../../src` 的网关契约层；配置保存/启动都走同一份 strict schema 与 `preflight`（群聊、微信登录凭据、直连平台域名、userbot 关键词一律拒绝） |
| 令牌只能 safeStorage 加密或环境变量 | 令牌输入后立即 `safeStorage.encryptString` 落盘到 `userData/easybot-token.bin`（0600），或从 `EASYBOT_TOKEN`（或配置里 `gateway.tokenEnv` 指定名）读取；不写 config.yaml、不进日志、不进渲染进程、不进 URL；UI 只显示"已保存/来源" |
| 伴生 API 默认 127.0.0.1 | 默认 `127.0.0.1:17871`；局域网模式必须 UI 显式开关 + `window.confirm` 确认 + 警告横幅 + 6 位一次性配对码；无 token 一律 401；不提供正文/原始报文接口；配置只读 |
| 未签名构建不引入自动更新/遥测 | `electron-builder.yml` 不配置 `publish`/updater；代码中无 `autoUpdater`、无任何上报逻辑；关于页明确标注"未签名构建" |
| 依赖白名单 | 仅 `electron`、`electron-builder`、`esbuild`、`typescript`、`@types/node`；核心运行期依赖（yaml/zod/ws）在 esbuild 打包时从仓库根 `node_modules` 解析并内联，不在桌面端重复声明 |

### 伴生 API 契约（`127.0.0.1:17871`，端口可配）

* 鉴权：`Authorization: Bearer <token>`；**除 `POST /api/pair` 外，所有 `/api/*` 无 token 一律 401**。
* 静态资源：同端口 `/` 提供 `companion-web` 构建产物（浏览器页面无法附带 Authorization 头，
  故静态 shell 公开；其中不含任何数据）。
* CORS：仅 `http(s)://localhost`、`http(s)://127.0.0.1`（任意端口）与 `capacitor://localhost`；
  预检只允许 `GET/POST` + `Authorization/Content-Type`。
* 请求体上限 16KB（超出 413）；所有响应 `Cache-Control: no-store`；错误响应不反射请求体。
* 端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/pair` | `{code}`（6 位、10 分钟、一次性）→ `{token, expiresAt}`；失败 401，限流 5 次/分钟/IP |
| GET | `/api/health` | `{ok:true, app:"im-forwarder-desktop", version}` |
| GET | `/api/status` | `{running, startedAt, routeCount, gateway:{baseUrlHost}, crossBorderOpen, counts:{forwarded,failed,skipped}}` |
| POST | `/api/control` | `{action:"start"\|"stop"}` → `{running}`；预检失败 → 409 `{violations:[{code,message}]}` |
| GET | `/api/routes` | 脱敏路由（无 `conversationId`、无 `receiver`） |
| GET | `/api/logs?limit=100` | 白名单日志数组（1–1000，从内存环形缓冲读取，绝不落盘） |
| 其它 | — | 未知路径 404；方法不允许 405（带 `Allow`） |

* 长令牌：32 字节随机数（base64url），有效期 90 天；与配对码一样用 **SHA-256 + `crypto.timingSafeEqual`**
  做恒定时间比较。safeStorage 不可用时令牌只存内存（重启后需重新配对），绝不退化明文落盘。
* 局域网模式警告：UI 与 README 均明确"同网段设备可尝试连接、配对码勿外泄、API 只读且无正文接口"。

---

## 4. 已知取舍与限制

1. **未签名构建**：Windows/macOS 首次运行可能触发 SmartScreen/Gatekeeper 提示；本项目不提供
   自动更新与公证，升级请重新下载官方构建。
2. **令牌持久化依赖系统密钥环**：Linux 无可用 keyring 时 `safeStorage` 不可用，UI 会禁用
   "保存令牌"并提示改用环境变量（绝不退化为明文存储）。
3. **伴生 API 的静态资源是公开的**：手机浏览器无法在顶层导航里附加 `Authorization`，因此
   静态 PWA shell 不鉴权；所有数据接口仍强制 Bearer token，且响应 `no-store`。
4. **配置只读（V1）**：手机端只能查看脱敏路由与状态，不能修改配置；修改必须在桌面端完成。
5. **核心进程仍需单独停止后重启**才能应用新配置（不做热重载，避免"未知合规状态"）。
6. **本应用不代为完成任何法定合规程序**（PIPL 出境安全评估/标准合同/单独同意等），
   开启 Telegram 出境或他人内容转发仅表示使用者自担责任并留痕。

---

## 5. 自测

```powershell
cd apps/desktop
npm run typecheck
npm run build
npm run smoke                     # 正例（配置合规 + EASYBOT_TOKEN 已设置）→ 0
npm run smoke                     # 反例（含 Telegram 路由且闸门关闭）→ 78
node scripts/companion-smoke.mjs  # 401 → pair → status → routes → logs → 405/404/413 全链路
```

`companion-smoke.mjs` 会以子进程方式启动 `dist/companion-server.cjs`（不依赖 Electron/显示器），
逐项校验鉴权、配对码一次性、脱敏路由、白名单日志、CORS、方法码与请求体上限。

---

## 6. 问题反馈

<https://github.com/DaiYiqq/im-forwarder/issues>
