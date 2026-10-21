# im-forwarder · 微信 ↔ QQ ↔ Telegram 三平台消息转发路由服务

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [繁體中文](README.zh-TW.md)

[![CI](https://github.com/DaiYiqq/im-forwarder/actions/workflows/ci.yml/badge.svg)](https://github.com/DaiYiqq/im-forwarder/actions/workflows/ci.yml)
[![License: MIT + Commons Clause](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

> 🧪 **在线 Demo（纯静态、无后端）**：https://daiyiqq.github.io/im-forwarder/
> 演示合规闸门决策链、出境闸门与路由矩阵 —— 不连接任何平台、不发送消息、不收集数据。真实转发需桌面端 + 你自己的 EasyBot 网关。

> ## ⚠️ 禁止用于商业场景、收费服务或付费托管
>
> 本项目**仅供技术研究与个人学习**。
> 微信侧接入的是腾讯官方 iLink（ClawBot）开放能力，其授权限于**非商业目的**；
> [LICENSE](LICENSE) 采用 MIT + Commons Clause，明确禁止**出售、付费托管、转卖**。
> 任何收费转发、付费托管、作为商业产品的一部分提供，均**不在授权范围内**。
>
> 若需要商业化的跨平台消息同步，请向各平台申请官方企业级方案，不要使用本项目。

---

## 一、风险提示（请在安装前逐条读完）

1. **仅供技术研究学习，禁止商业用途。** 见 [LICENSE](LICENSE)（MIT + Commons Clause，禁止收费、付费托管、转卖）。
2. **微信侧只能走官方 iLink（ClawBot）通道**，接入域名为 `ilinkai.weixin.qq.com`（由 EasyBot 网关侧完成官方授权）。
   本项目**不含任何**微信登录、扫码、Cookie、Web 协议、iPad 协议、Hook、逆向代码。
   微信侧**仅处理私聊消息**：群聊消息既不接收也不发送；不调用好友目录、撤回、历史查询等未开放能力。
   iLink 授予的是**非商业目的**许可 —— 把本项目用于任何收费场景都会同时违反该项许可。
3. **QQ 侧使用 NapCat + OneBot 11，不是 QQ 官方机器人通道。**
   通过 NapCat 登录个人 QQ 号存在**登录验证、频繁掉线、封号**等风险。
   **必须使用专门的小号**，严禁使用主力账号；由此产生的一切后果由使用者自行承担。
4. **Telegram 侧只能使用官方 Bot API**（通过 BotFather 创建机器人）。
   本项目**严禁**使用 MTProto userbot、Telethon、Pyrogram 等以**个人号身份**登录的方案，
   源码中不存在任何此类代码路径。Telegram 机器人只能接收用户主动发给它的消息、
   或它所在群组中经授权的消息；本项目不尝试读取任何用户私聊历史或他人会话。
5. **数据出境（重点）**：Telegram 服务器位于**境外**。从微信/QQ 转发消息到 Telegram，
   **可能构成《个人信息保护法》第三十八条所称的「向境外提供个人信息」**。因此：
   - 转发到 Telegram 的功能默认**关闭**，必须在配置中显式开启；
   - 开启时必须确认「**仅转发本人自己的消息，不转发他人聊天内容**」；
   - 第三十八条/第三十九条的对应关系见 [COMPLIANCE.md](COMPLIANCE.md)。
6. **境内网络访问合规**：Telegram 在中国大陆的访问受相关法律法规约束。
   使用者应自行确保网络接入方式合法合规。**本项目不提供、也不建议任何规避性网络方案**，
   仓库中不存在代理、隧道、混淆等相关代码或配置。
7. **免责**：作者不对使用者的账号安全（封号、冻结、验证失败）、数据泄露、
   第三方滥用、以及任何违反所在地法律法规的行为承担责任。
   本项目按 [LICENSE](LICENSE)「按现状」提供，不附带任何明示或默示担保。

> 本项目不是法律意见。涉及个人信息处理的合规判断，请咨询专业律师。

---

## 二、它做什么 / 不做什么

| | 本项目 | 说明 |
|---|---|---|
| 协议层 | ❌ 不做 | 微信 iLink / NapCat / Telegram Bot API 的连接全部由 **EasyBot 网关**完成 |
| 转发路由 | ✅ 做 | `源平台:源会话 → 目标平台:目标会话` 的路由矩阵，支持任意两平台 |
| 消息类型 | 仅文本 | 其它类型**显式回执 + 跳过**，不静默丢弃、不自行下载/解析媒体 |
| 微信群聊 | ❌ 不做 | 编译期 + 运行期双重拒绝，且**没有**任何配置开关可以放开 |
| 消息持久化 | ❌ 不做 | 无数据库、无队列落盘、无磁盘缓存；正文只在内存中完成转换与转发 |
| 正文日志 | ❌ 不做 | 日志字段白名单，物理上没有"正文"字段（见 `src/observability/logger.ts`） |
| 他人内容转发 | 默认关闭 | 需开启「告知—同意」机制，未取得同意不转发 |
| Telegram 出境 | 默认关闭 | 需四项确认齐备；缺失任一项 → **进程拒绝启动** |

### 数据流

```
   微信私聊(iLink官方) ──▶┌──────────────────────────────────────┐
   QQ 私聊(NapCat)    ──▶│   EasyBot 统一 IM 网关               │
   Telegram(Bot API)  ──▶│   · 各平台 PlatformAdapter           │
                         │   · 统一 REST(发送) + WebSocket(事件)│
                         └───────────────┬──────────────────────┘
                                         │  统一事件 / 统一发送请求
                                         ▼
                         ┌──────────────────────────────────────┐
                         │   im-forwarder（本仓库）             │
                         │   合规前置检查 → 路由矩阵 → 策略链   │
                         │   → 文本转换 → 发送 → 白名单日志     │
                         └──────────────────────────────────────┘
```

**本服务不持有任何平台凭据**，只持有一个 EasyBot 网关的访问令牌（从环境变量读取）。

---

> 桌面端（Windows/macOS/Linux）与移动端（PWA / Android APK）安装包说明见 [docs/INSTALL.md](docs/INSTALL.md)；iOS 不提供安装包（原因见该文档）。

## 界面预览（真实桌面端 · 演示数据）

<img src="demo/images/desktop-status.png" alt="桌面端状态页" width="720" />

<img src="demo/images/desktop-demo.gif" alt="桌面端操作动图" width="720" />

截图由**真实 Electron 渲染进程**离屏截取（`apps/desktop/scripts/capture-main.cjs`），数据为固定演示数据，
**不含任何真实聊天内容或令牌**。在线 Demo 支持中英切换、出境闸门演练、路由矩阵编辑与截图预览：
https://daiyiqq.github.io/im-forwarder/

## 三、快速开始

### 前置条件

- Node.js ≥ 20（开发验证使用 Node 24）
- 已部署好的 **EasyBot 网关**，并且已在其内部完成：
  - 微信：官方 iLink（ClawBot）通道授权（扫码授权由网关与腾讯官方完成）
  - QQ：NapCat 登录（**请使用专门小号**）
  - Telegram（可选）：BotFather 创建机器人并填入网关
- 本仓库不负责上述任何一步，也不会替你完成。

### 安装

```powershell
git clone https://github.com/DaiYiqq/im-forwarder.git
cd im-forwarder
npm install
Copy-Item config/config.example.yaml config/config.yaml
# 注意：本项目**不加载 .env 文件**（没有 dotenv 依赖），令牌必须通过真实环境变量注入。
```

### 配置令牌（只从环境变量读取，禁止写进配置文件）

```powershell
$env:EASYBOT_TOKEN = "<你的 EasyBot 网关令牌>"
```

### 启动前自检（推荐每次都跑）

```powershell
npx tsx src/main.ts --config config/config.yaml --self-check
# 退出码 0 = 配置与合规检查通过；78 = 未通过（会打印逐条原因与修改建议）
```

### 运行

```powershell
npm start
```

### 本地无平台联调（mock 网关，不接触任何真实账号）

```powershell
npm run mock                   # 终端 A：启动假网关
# 终端 B：把 config.yaml 的 baseUrl/eventsUrl 指向 mock 打印出的地址后再 npm start
```

---

## 四、路由矩阵

配置项采用 `源平台:源会话ID → 目标平台:目标会话ID` 的映射表，**不是两两硬编码**：

```yaml
routes:
  - id: wx-private-to-qq          # 微信私聊 → QQ 指定会话
    group: self-wx-qq             # 同一逻辑链路；回环防护按 group 判定
    contentOwner: self            # 必填：self | third-party（无默认值）
    from: { platform: wechat, conversationId: "wxid_xxx", chatType: private }
    to:
      - { platform: qq, conversationId: "10001", chatType: private }

  - id: qq-to-wx-private          # 反向边
    group: self-wx-qq
    contentOwner: self
    from: { platform: qq, conversationId: "10001", chatType: private }
    to: { platform: wechat, conversationId: "wxid_xxx", chatType: private }
```

编译期规则（不满足即**拒绝启动**，不做自动取舍）：`chatType` 只能 `private`（所有平台）；
`from`/`to` 不得相同；同一 group 的 `contentOwner` 必须一致；重复 id/边失败；
有环必须开启 `loopGuard`，且环不得跨 group。

回环防护三层：**回显 messageId → 短期内容指纹（HMAC，仅内存）→ hop 预算**（默认 `maxHops: 1`）。
详见 [docs/ROUTING.md](docs/ROUTING.md)。

---

## 五、合规开关（默认全关，缺失即拒绝启动）

### 数据出境（PIPL 第 38/39 条）

```yaml
compliance:
  telegramCrossBorder:
    enabled: true
    operator: "你的署名"                        # 谁开的，要能追溯
    acknowledgedAt: "2026-10-18T12:00:00+08:00" # ISO8601
    selfMessagesOnlyConfirmed: true             # 仅转发本人消息
    riskNoticeVersion: "2026-10-18.v1"          # 文案版本变更后需重新确认
```

任一缺失 / 版本不匹配 → `CROSS_BORDER_GATE_CLOSED` 或 `CROSS_BORDER_ACK_INCOMPLETE` → **exit 78**。

### 他人的聊天内容（PIPL 第 23 条）

默认**没有任何** third-party 路由。若需转发他人内容：开启 `thirdPartyConsent.enabled`，
并为每个目标补齐告知要素（`receiver.*`）；对方首条消息**不转发**，先发告知，
对方回复「同意转发」后才开始转发；出境链路需要**两次独立同意**。
详见 [docs/CONSENT-FLOW.md](docs/CONSENT-FLOW.md) 与 [COMPLIANCE.md](COMPLIANCE.md)。

---

## 六、日志与隐私

```json
{"ts":"2026-10-18T12:34:56.789Z","level":"info","event":"forward","status":"forwarded","routeId":"wx-private-to-qq","sourcePlatform":"wechat","targetPlatform":"qq","latencyMs":42}
```

- 只有白名单字段（`ts/level/event/routeId/sourcePlatform/targetPlatform/status/errorCode/...`）；
- **没有**消息正文、没有会话 ID、没有昵称；
- 超长字符串字段会被替换为 `[omitted:N]`，防止把正文塞进"合法字段"；
- 该性质由 `test/redaction.spec.ts` 用 canary 文本断言，不是口头承诺。

---

## 七、已知限制（不粉饰）

1. **网关契约需核对**：字段差异通过 `gateway.fieldMap` 与 `gateway.send.path` 覆盖，
   **不要**为此引入任何平台 SDK。见 [docs/GATEWAY-CONTRACT.md](docs/GATEWAY-CONTRACT.md)。
2. **只支持文本**：媒体一律显式跳过；本项目不做任何媒体解析。
3. **不支持群聊**（任何平台；群内无法逐成员取得同意）。
4. **同意机制的能力边界**：只能证明"该私聊会话的回复方声称同意"，无法验证身份；
   已转发出去的消息无法追回。
5. **内存擦除无法保证**：JS 运行时不提供可控的内存清零；本项目的边界是"不落盘、不入日志、不入队列"。
6. **NapCat 掉线/封号不可避免**：非官方通道的固有风险，本项目不做任何规避。
7. **`contentOwner` 是自述字段**：把他人会话标成 `self` 即可绕过同意机制，程序无法判断会话归属。
8. **同意记录没有签名**：`data/consent.json` 是本机 JSON，可被伪造，只具内部可信度。
9. **信任边界在网关**：`chatType`、`senderIsSelf`、`senderIsBot` 均来自网关上报；
   网关侧自身的合规性是本项目最大的未知项，不在本仓库可控范围内。

---

## 八、质量门禁

```powershell
npm run check        # typecheck + 静态合规扫描 + 全量测试（63 个用例）
npm run typecheck
npm run compliance:scan
npm test
```

CI 见 [.github/workflows/ci.yml](.github/workflows/ci.yml)；独立审计报告见
[docs/AUDIT.md](docs/AUDIT.md)（8 条验收、黑盒退出码、PoC、整改记录）。

---

## 九、开发者联系方式

| 渠道 | 信息 |
|---|---|
| 开发者 | **戴亿（DaiYi）** |
| GitHub | [@DaiYiqq](https://github.com/DaiYiqq) |
| QQ 邮箱 | **1703205607@qq.com** |
| Gmail | **daiy91004@gmail.com** |
| QQ | **1703205607** |
| 微信 | **daiyi091004** |
| 抖音 | **daiyi091004** |
| Issue（推荐反馈 Bug） | [github.com/DaiYiqq/im-forwarder/issues](https://github.com/DaiYiqq/im-forwarder/issues) |

- **安全漏洞或滥用举报**请先看 [SECURITY.md](SECURITY.md)，不要在公开 Issue 里贴凭据、聊天内容或个人信息。
- 请勿通过任何渠道发送敏感个人信息。
- 完整联系方式与沟通约定见 [CONTACT.md](CONTACT.md)。

---

## 十、社区共同维护

本项目**由社区共同维护**，但有一条不可让渡的红线：**合规不变量不得被削弱**。

- **贡献指南**：[CONTRIBUTING.md](CONTRIBUTING.md) —— 流程、代码风格、必跑检查、
  以及 PR 不得破坏的合规不变量清单。
- **治理规则**：[GOVERNANCE.md](GOVERNANCE.md) —— 角色、评审规则、发布流程。
- **翻译**：[TRANSLATIONS.md](TRANSLATIONS.md) —— 简体中文为基准（默认展示），英文/日文/繁体中文为社区维护译本。
- **行为准则**：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- **英文文档**：`docs/en/`（COMPLIANCE / ROUTING / GATEWAY-CONTRACT / CONSENT-FLOW / OPERATIONS 全文 + AUDIT 英文摘要），供海外贡献者阅读。
- **合规讨论**：使用 *compliance concern* 类 Issue 模板。
- **新手任务**：标签 `good first issue`；文档与翻译修正永远欢迎。

谁能合并什么、需要几位评审：见 [GOVERNANCE.md](GOVERNANCE.md)。任何触及
`src/compliance/**`、`src/config/schema.ts`、`LICENSE`、`COMPLIANCE.md` 的 PR，
都需要第二位评审，并且 `npm run check` 必须全绿。

---

## 十一、许可证

MIT **+ Commons Clause**：允许使用、复制、修改、合并、发布、分发、再许可；
**禁止出售、付费托管、转卖**。完整文本见 [LICENSE](LICENSE)。
该组合**不是** OSI 认可的开源许可，请勿按开源项目使用。

本项目与腾讯、QQ、Telegram 无隶属关系；相关商标归各自权利人所有。
