# 在线 Demo / Live demo

> 静态演示页，部署在 GitHub Pages：
> **https://daiyiqq.github.io/im-forwarder/**

## 它是什么

纯前端（HTML/CSS/JS）演示，用来快速理解这个项目的核心价值：**合规闸门为什么必须默认关闭、
消息为什么会被拦截**。支持**中英切换**（默认中文，纯内存切换，不写任何存储）。五个页签：

1. **决策链演练**：10 个场景（群聊、图片、自身消息、机器人、无路由、出境闸门关闭、他人内容未同意、
   回环、CQ 码注入…），展示策略链 P0–P8 逐步判定、最终状态、白名单日志与模拟发送请求。
2. **出境闸门**：现场切换 PIPL 第 38/39 条对应的五要素，观察 `EXIT 0` 与 `EXIT 78`。
3. **路由矩阵**：有向边、出境边、third-party、环与回环防护要求。
4. **矩阵编辑器**：增删改路由（平台/会话/chatType/contentOwner），实时编译并列出问题
   （自环、重复 id/边、group 冲突、环、跨 group 环、出境闸门、third-party 未开同意）。
   所有数据只在内存，刷新即恢复；真实配置请用桌面端配置页保存。
5. **界面截图**：真实桌面端界面（Electron 离屏渲染 + 固定演示数据）的 4 张截图 + 1 张动图。

## 它不是什么

- **不能转发任何消息**：页面不连接 EasyBot 网关、不连接微信/QQ/Telegram；
- **不接收真实数据**：没有输入框要求令牌，所有场景是内置假数据；
- **没有后端、没有存储**：`fetch` / `XMLHttpRequest` / `WebSocket` / `localStorage` / `sessionStorage` /
  `indexedDB` 在演示代码中都不存在（CI 会 grep 检查）；
- **不是合规证明**：演示策略是 `src/routing/policy.ts` / `src/routing/matrix.ts` 的简化镜像，
  真实行为以源码与测试为准。

## 目录

```
demo/
├─ index.html            页面结构 + 交互（含语言切换、编辑器）
├─ styles.css            样式（无外部字体/CDN）
├─ policy-demo.js        策略镜像（双语）：决策链 + 矩阵编译
├─ i18n.js               静态文案（zh/en，91 个 key）
├─ policy-demo.test.mjs  自检：行为 + i18n 完整性 + 截图/GIF 合法性
├─ README.md             本文件
└─ images/               真实桌面端截图与动图（由 capture 脚本生成）
```

## 本地预览

```bash
# 任选其一（无依赖）
npx --yes serve demo          # 或 python -m http.server -d demo 8000
# 浏览器打开 http://localhost:3000 （或 8000）
```

也可以直接双击 `demo/index.html`（注意部分浏览器对 `file://` 的限制，
若样式或脚本异常请用本地服务器）。

## 自检

```bash
node demo/policy-demo.test.mjs
```

覆盖：10 个场景决策、矩阵编译的 8 类问题、91 个 i18n key 的中英一致性与使用完整性、
4 张 PNG + 1 张 GIF 的文件头与大小。CI 部署前会强制执行。

## 更新截图/动图

截图由真实 Electron 渲染进程生成（离屏渲染 + mock preload，不连接任何平台）：

```bash
npm --prefix apps/desktop install      # 首次
npm --prefix apps/desktop run capture  # 输出到 demo/images/
```

脚本：`apps/desktop/scripts/capture-main.cjs`（页面见 `capture-preload.cjs`）。
UI 改动后请重新生成，并提交 `demo/images/` 的更新。

## 部署

推送到 `main` 且改动 `demo/**` 时自动部署（GitHub Pages，`build_type: workflow`）。
CI 守卫：静态文件存在性、禁用词、网络请求/存储禁令、外部图片禁令、策略自检。
