# apps/companion-web · 移动伴生控制端（PWA / Capacitor WebView）

im-forwarder 的**共享 Web 应用**：桌面端 Electron 应用会提供伴生 HTTP API，本应用通过它查看
转发状态 / 脱敏路由 / 白名单日志并启停转发；同一份产物同时作为 PWA（"添加到主屏幕"）和
Android APK 的 WebView 内容（`apps/mobile` 的 `webDir` 指向本包 `dist/`）。

- 中文 UI，原生 HTML/CSS/JS（TypeScript 编译），无框架。
- 依赖白名单：仅 `esbuild` + `typescript`（构建期）。运行期零第三方依赖。
- 不显示、不缓存、不持久化任何消息正文；令牌只存内存；无遥测/崩溃上报/自动更新。

## 目录

```
apps/companion-web/
├─ package.json            scripts: build / typecheck / dev / test
├─ tsconfig.json
├─ src/
│  ├─ index.html           应用外壳 + CSP（default-src 'self'）
│  ├─ app.ts               哈希路由：连接/状态/路由/日志/实验模式/关于
│  ├─ api.ts               桌面伴生 API 客户端（Bearer + 错误归一化 + 白名单投影）
│  ├─ store.ts             连接配置：host 可持久化，token 仅内存
│  ├─ style.css
│  ├─ manifest.webmanifest
│  ├─ sw.js                只缓存应用外壳，绝不缓存 /api/*
│  └─ experimental/        B 模式（浏览器端受限转发核心）
│     ├─ gateway.ts        WS 订阅 + REST 发送（令牌仅内存）
│     ├─ routing.ts        路由 JSON 校验（仅 private + 仅 wx↔qq + 仅 self）
│     ├─ loop-guard.ts     messageId 回显 + Web Crypto HMAC 短时内容指纹
│     ├─ transform.ts      复制自核心 src/pipeline/transform.ts（CQ 转义 + 截断）
│     └─ runner.ts         前台转发循环；visibilitychange → 立即停止
├─ test/*.spec.ts          node:test（纯逻辑，不依赖 DOM）
├─ scripts/                build / dev / test / PNG 图标生成
└─ dist/                   构建产物（gitignored；桌面端静态托管 & Capacitor webDir）
```

## 构建与本地验证

```bash
cd apps/companion-web
npm ci                 # 或 npm install
npm run typecheck      # tsc --noEmit（含 test/**/*.ts）
npm test               # esbuild 预编译 test/*.spec.ts → node --test
npm run build          # esbuild 打包 + 拷贝静态文件 + 生成图标 → dist/
npm run dev            # 本地静态服务器 http://127.0.0.1:5173/（含 watch）
```

构建产物自检要点：

- `dist/index.html`、`dist/app.js`、`dist/style.css`、`dist/manifest.webmanifest`、`dist/sw.js` 存在；
- `dist/icons/icon-192.png`、`icon-512.png`、`maskable-512.png`、`apple-touch-icon.png` 为合法
  8-bit RGBA PNG（`scripts/icons.mjs` 纯 Node 手写 PNG 编码，无图像库）；
- `dist/` 内无 sourcemap、无第三方依赖、无内联脚本/样式。

CI（`.github/workflows/release.yml` 的 `web` job）用 Node 20 跑 `npm ci && typecheck && test && build`；
`npm test` 之所以先 esbuild 再 `node --test`，是因为依赖白名单里没有 tsx，而 Node 20 不支持原生
type stripping。

## 桌面伴生 API 契约（0.2.0，严格按此调用）

| 方法 | 路径 | 鉴权 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/health` | 无 | `{ok, app, version}` |
| POST | `/api/pair` `{code}` | 无 | `{token, expiresAt}`（6 位配对码） |
| GET | `/api/status` | Bearer | `{running, startedAt, routeCount, gateway:{baseUrlHost}, crossBorderOpen, counts:{forwarded,failed,skipped}}` |
| POST | `/api/control` `{action:"start"\|"stop"}` | Bearer | `{running}`；预检失败 `409` + `violations: string[]` |
| GET | `/api/routes` | Bearer | 脱敏路由数组（无 conversationId / receiver） |
| GET | `/api/logs?limit=100` | Bearer | 白名单字段数组 |

错误归一化（`src/api.ts`）：

| 状态 | UI 提示 |
| --- | --- |
| 401 | 令牌无效/过期 → 回「连接」页用新的 6 位配对码重新配对（令牌只在内存） |
| 409 | 预检未通过 → 逐条列出 `violations`，不启动 |
| 429 | 请求过于频繁 → 显示 `Retry-After` 秒数 |
| 503 | 桌面端伴生 API 暂不可用 → 稍后重试 |
| 网络失败 | 检查：同一局域网 / 桌面端「局域网访问」开关 / 电脑防火墙端口 |

> **给桌面端的两点对接要求（不在原契约文字里，但浏览器安全模型强制）**
>
> 1. **CORS**：本应用在浏览器/PWA（以及 Capacitor WebView 的 `http://localhost` 源）里跨源调用桌面
>    API，桌面端必须返回 CORS 头（例如 `Access-Control-Allow-Origin` 允许伴生端来源，允许
>    `Authorization` 请求头与 `POST`）。PWA 与 WebView 的来源不同，若只支持一个来源，建议允许
>    `*`（本 API 用 Bearer 令牌而非 Cookie，`*` 不会携带凭据）。
> 2. **令牌响应**：`POST /api/pair` 的 `token` 必须是不可猜测的高熵字符串；本应用只把它放在
>    `Authorization: Bearer` 头里，不进 URL。

## 安全与合规实现（对应任务书红线）

| 红线 | 实现位置 | 说明 |
| --- | --- | --- |
| 不显示/缓存/持久化正文 | `api.ts` 的 `pickLogFields`/`routes` 白名单投影；`runner.ts` 日志白名单 | 即使服务端多发了 `text` 等字段也会被丢弃；B 模式日志只有元数据 |
| B 模式只允许文本/私聊/self/wx↔qq | `experimental/routing.ts` + `runner.ts` | 校验 fail-closed；Telegram、third-party、群聊、媒体全部显式拒绝/跳过 |
| 令牌只存内存 | `store.ts`（A 模式）、`gateway.ts`（B 模式） | token 无任何持久化分支；B 模式停止/连接关闭即清零；不写 URL/日志 |
| 不引入平台登录/个人号协议客户端/群聊/媒体解析 | 全包无相关依赖与代码路径 | 依赖仅 esbuild/typescript；B 模式仅构造 text 片段 |
| CSP 严格 | `index.html` | `default-src 'self'`；仅 `connect-src` 放行用户配置的网关 `http(s)/ws(s)`；无 `unsafe-inline`/`unsafe-eval` |
| 无遥测/崩溃上报/自动更新 | 全包 | 无相关代码与依赖 |
| SW 不缓存 API | `sw.js` | 仅同源 GET 且路径不含 `/api/`；跨源直接放行 |

### 为什么 `connect-src` 要放行 `http:`/`ws:` 全域

桌面端/网关地址由用户在运行时填写（局域网 IP + 端口），构建期无法枚举。因此 CSP 采用
「默认全锁 + connect-src 按协议放行」；具体目标地址由代码再做一次严格校验
（`normalizeHost` / `normalizeGatewayUrl`：只允许 http(s)/ws(s)、禁止 URL 内嵌凭据、禁止把令牌
放进 URL）。这是任务书红线 4 明确允许的口径。

## B 模式（实验，默认关闭）

定位：在 WebView/浏览器里**直连 EasyBot 网关**（WS + REST）跑一个受限子集。默认关闭，
进入页面必须勾选风险确认才能启动。页面切后台/锁屏/刷新 → `visibilitychange` 立即停止并清空
内存令牌与指纹表。

运行中显示：已转发/失败/跳过计数、最近 20 条元数据日志、跳过提示、醒目实验性横幅。

限制清单（也用于交付报告）：

1. **仅前台**：锁屏、切后台、刷新页面、WebView 被回收即停止（无后台服务、无 WakeLock）。
2. **仅文本**：`kind !== "text"` 一律跳过并提示；不解析/不下载/不转码任何媒体。
3. **仅私聊**：`chatType !== "private"` 一律跳过并提示。
4. **仅本人路由**：`contentOwner` 必须为 `self`；无 third-party 分支（也没有同意流程）。
5. **仅微信 ↔ QQ**：Telegram 无论出境/入境都拒绝；不接受任何第三方平台。
6. **WebSocket 鉴权限制**：浏览器不能给 WS 设置 `Authorization` 头，也不能把令牌放 URL（红线）。
   因此本模式要求网关支持 `Sec-WebSocket-Protocol: bearer.<base64url(token)>` 子协议，
   并允许本页面来源的 CORS；否则只能使用 A 模式。
7. **无自动重连/无重试**：断线即提示，用户手动重连；避免静默重复发送。
8. **只转发一次（无多跳）**：命中一条路由的所有目标后不再二次转发；回环由 messageId 回显 +
   HMAC 内容指纹（默认 20 秒窗口）兜底。
9. **内容指纹只在内存**：随机盐每实例生成，停止即丢弃；不打印、不落盘、不进 UI。
10. **不持久化任何配置**：WS/REST 地址与路由 JSON 只在内存；令牌启动后立即从输入框清除。
11. **设备/浏览器能力**：需要 Web Crypto（HMAC）与 WebSocket；老内核会明确报错并拒绝启动。

## PWA

桌面端静态托管 `dist/` 后，手机浏览器打开该地址 → 菜单「添加到主屏幕」。
Service Worker 只在 https / localhost 注册；局域网 http 访问时无离线外壳（属预期）。
`manifest.webmanifest` 提供 192/512/maskable 图标与 standalone 显示。

## Capacitor

`apps/mobile/capacitor.config.ts` 将 `webDir` 指向 `../companion-web/dist`。
移动端构建：`cd apps/mobile && npm run sync`（先构建本包，再 `cap sync`）。
