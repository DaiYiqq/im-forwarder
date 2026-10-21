# 在线 Demo / Live demo

> 静态演示页，部署在 GitHub Pages：
> **https://daiyiqq.github.io/im-forwarder/**

## 它是什么

纯前端（HTML/CSS/JS）演示，用来快速理解这个项目的核心价值：**合规闸门为什么必须默认关闭、
消息为什么会被拦截**。四个页签：

1. **决策链演练**：选择场景（群聊、图片、自身消息、机器人、无路由、出境闸门关闭、他人内容未同意、
   回环、CQ 码注入…），看策略链 P0–P8 逐步判定与最终状态、白名单日志、模拟发送请求。
2. **出境闸门**：现场切换 PIPL 第 38/39 条对应的五要素，观察 `EXIT 0` 与 `EXIT 78`。
3. **路由矩阵**：有向边、出境边、third-party、环与回环防护要求。
4. **伴生控制台（模拟）**：桌面端 → 手机端的状态/配对码/日志外观（全部假数据）。

## 它不是什么

- **不能转发任何消息**：页面不连接 EasyBot 网关、不连接微信/QQ/Telegram；
- **不接收任何输入中的真实数据**：没有输入框要求令牌，所有场景是内置假数据；
- **没有后端**：`fetch` / `XMLHttpRequest` / `WebSocket` 在演示代码中都不存在（CI 会 grep 检查）；
- **不是合规证明**：演示策略是 `src/routing/policy.ts` 的简化镜像，真实行为以源码与测试为准。

## 本地预览

```bash
# 任选其一（无依赖）
npx --yes serve demo          # 或 python -m http.server -d demo 8000
# 浏览器打开 http://localhost:3000 （或 8000）
```

也可以直接双击 `demo/index.html`（无需服务器；注意部分浏览器对 `file://` 的限制，
若样式或脚本异常请用上面的本地服务器）。

## 自检

演示策略镜像有独立断言，改动演示逻辑后必须跑：

```bash
node demo/policy-demo.test.mjs
```

CI（`.github/workflows/pages.yml`）在部署前会执行：
静态文件存在性、禁用词检查（不得出现平台凭据/登录标识）、
**网络请求禁令**（不得出现 `fetch(` / `XMLHttpRequest` / `WebSocket(`）、以及上面的自检。

## 部署

推送到 `main` 且改动 `demo/**` 时自动部署（GitHub Pages，`build_type: workflow`）。
仅供演示，不参与安装包流水线。
