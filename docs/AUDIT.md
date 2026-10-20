# im-forwarder 独立合规审计报告

| 项 | 内容 |
|---|---|
| 审计对象 | `D:\openclaw\im-forwarder`（代码版本 `0.1.0`，风险告知版本 `2026-10-18.v1`） |
| 审计立场 | 甲方委托的独立审计者。不采信 README / COMPLIANCE.md 的自述，只采信代码、配置与命令输出；审计方法是"尽力证明它不合规"。 |
| 审计时间 | 2026-10-18（工作副本快照与关键文件哈希见 §1.1「版本锚点」） |
| 运行环境 | Windows，Node v24.21.0，npm 11.19.0，依赖已安装（lockfileVersion 3） |
| 结论 | **未发现阻断级不合规问题**；8 条验收标准中 5 条"通过"、3 条"通过（有保留）"；另有 1 项可绕过的防护边界、若干文档失真与信任边界风险，见 §8。 |

> 本报告不是法律意见。所有结论仅针对"本仓库代码是否具备所述能力/约束"，不评价使用者的实际部署是否合法。审计中未连接任何真实平台、未安装依赖、未修改 `src/**`、`test/**`、`config/**`、`package.json`、既有文档；唯一写入的文件是本文件。

---

## 1. 审计范围与方法

### 1.1 覆盖范围

- 非 `node_modules` 文件 **50 个**（`Get-ChildItem -Recurse -Force` 全量枚举，含隐藏属性文件；本副本无 `.git`）。
  - `src/**` 22 个 TS 文件，约 3,890 行（全部逐行读过）；
  - `test/**` 11 个文件（10 个 spec + harness），约 2,230 行；59 个用例全部实际执行；
  - `scripts/` 3 个（`compliance-scan.mjs` 全文、`test.mjs` 全文、`mock-gateway.ts` 关键行为）；
  - `config/config.example.yaml`、`package.json`、`package-lock.json`、`tsconfig.json`、`.gitignore`、`.env.example`、`LICENSE`、`.github/workflows/ci.yml`；
  - `README.md`（277 行）、`COMPLIANCE.md`（376 行）、`docs/*.md` 4 份（共约 900 行），全部逐行读过。
- 依赖层：`package-lock.json` 全部 36 个 `node_modules/*` 条目及其依赖边；`node_modules` 顶层目录清单。
- 黑盒层：**24 份**临时配置/脚本（22 份 YAML + 1 份 PoC 脚本 + 1 份伪造 `consent.json`，另有若干 stderr 捕获文件；全部位于 `%TEMP%\imf-audit-20261018\`，未写入仓库），逐个以真实进程入口 `src/main.ts --self-check` 运行并读取真实退出码。

> **版本锚点（重要）**：审计期间工作副本发生了一次并发改动（2026-10-18 23:00:04 UTC+8）：`src/compliance/preflight.ts` 增加 7 行**注释**（平台定性说明，无逻辑变化，278→285 行）、`config/config.example.yaml` 增加 5 行**注释**（平台性质提醒，148→153 行）。本报告的最终结论、`npm run check` 与全部黑盒探测均已在改动后的工作副本上**复跑确认**（结果一致：exit 0 / 59 tests pass；a–e 仍全部 78，默认配置仍 0）。关键文件 SHA-256 前 12 位：`preflight.ts=b05d6d489356`、`config.example.yaml=7d7c093d4902`、`gates.ts=2de4d4de65f2`、`forward.ts=f11883ad9654`。

### 1.2 实际执行的命令（摘要）

| # | 命令 / 工具 | 目的 |
|---|---|---|
| 1 | `npm run check`（= `tsc --noEmit` + `compliance:scan` + `node scripts/test.mjs`） | 复跑项目自称的质量门禁，实测 **exit 0**：类型检查通过、静态扫描 23 个文件 0 问题、59 tests / 59 pass / 0 fail |
| 2 | 独立 `grep`/ripgrep 扫描 ×15+（src、scripts、test、config、docs、README、COMPLIANCE 分目录） | 全仓关键词审计，不用项目自带 scan 的结论 |
| 3 | `node -e`（读 lockfile、URL 归一化验证） | 依赖图逐条核对；验证 `URL.hostname` 对尾随点的处理 |
| 4 | `cmd /v:on /c "node --import tsx src/main.ts --config <tmp> --self-check >nul 2>nul & echo EXIT=!errorlevel!"` ×10（含 `config.example.yaml`） | 按甲方指定方法读取真实退出码 |
| 5 | 直接运行 `node --import tsx src/main.ts ...` ×25+ | 抓取 stderr 中的违规码、横幅、配置摘要；`--force`/`--skip-*`/环境变量旁路尝试 |
| 6 | `node --import tsx <tmp>/poc-consent.mts` ×1 | 同意机制穿透 PoC（自造 `Forwarder` 调用链，不触碰网络） |
| 7 | 临时 YAML ×22 / 临时 PoC 脚本 ×1 / 伪造 `consent.json` ×1 | 黑盒前置检查、YAML 解析边界、同意机制穿透、同意记录伪造测试 |

### 1.3 明确"我没有覆盖什么"

见 §8.2。最重要三条：**未做动态网络抓包**（不访问真实平台）；**未验证 EasyBot 网关本身是否合规**（微信登录授权、NapCat 登录、Telegram Bot API 调用都在网关侧，本仓库无法观测）；**未做法律层面的实质判断**。

---

## 2. 8 条验收标准逐条结论

| # | 验收标准 | 结论 | 一句话证据 |
|---|---|---|---|
| 1 | 是否存在任何绕过官方 iLink 的微信登录代码？ | **通过** | 全仓库无微信客户端/登录/扫码代码；依赖仅 `ws/yaml/zod`；唯一网络出口是"配置里的网关地址"，且 `config/load.ts` 拒绝平台凭据键（§5）。附 1 个防护绕过边界（§8.1-F1，不影响本条结论） |
| 2 | 是否尝试处理微信群聊消息？ | **通过** | 编译期 `WECHAT_GROUP_SOURCE_FORBIDDEN`/`WECHAT_GROUP_TARGET_FORBIDDEN`（`gates.ts:154-199`）+ 运行期 `skipped_group_forbidden`（`policy.ts:60-62`），无配置开关；黑盒实测 exit 78 |
| 3 | 是否出现 MTProto / Telethon / Pyrogram 个人号登录 Telegram 代码？ | **通过** | 代码 0 处实现、依赖 0 个相关包、无 `*.py`/`*.session` 产物；仅出现在"禁止清单/文档声明"（§5.2 逐条说明） |
| 4 | Telegram 路由是否默认关闭、是否有出境确认开关？ | **通过（有保留）** | 默认配置 0 条 Telegram 路由、闸门默认 CLOSED；四要素 + 版本校验缺一即 exit 78。保留点：**入境**（Telegram 源）路由不触发出境闸门，黑盒实测 exit 0（§3.1 补充项 f） |
| 5 | 转发他人消息是否有显式同意机制，而非默认开放？ | **通过（有保留）** | `contentOwner` 无默认值；未开同意 → `THIRD_PARTY_CONSENT_DISABLED`；运行期未同意一律 `blocked_consent_pending`；真实"告知→单独同意→记录→可撤回"流程。保留点：`contentOwner` 是自述字段、同意记录本地可伪造、粒度与文档表述不符（§4、§8） |
| 6 | 日志是否意外打印了消息正文？ | **通过** | 字段白名单 + 运行层 pick + 超长整体替换（`logger.ts:19-32,93-133`）；全仓 `.text` 相关引用 15 处，均不流向日志（§6.1）；`src/` 无 `console.log`；59 个测试含 canary 断言 |
| 7 | README 与 COMPLIANCE.md 是否真正写清风险，而非模板化免责？ | **通过（有保留）** | 风险逐条落到机制与法条，且给出代码位置；首段商业禁令在安装步骤之前。保留点：8 处"写了但没落地/写错"的机制性表述（§7.3） |
| 8 | 前置检查：转发他人消息或 Telegram 出境开启而确认未开时，进程是否拒绝启动并打印合规提示？ | **通过** | 5/5 份违规配置实测 **EXIT=78**，stderr 打印逐条中文原因与整改建议；无 `--force`/`--skip-*`/环境变量旁路（§3） |

---

## 3. 黑盒前置检查结果（自己构造配置 → 真实进程退出码）

### 3.1 甲方要求的 5 份配置 + 默认配置

执行方式（每份均设置 `$env:EASYBOT_TOKEN="t"`）：

```powershell
cd D:\openclaw\im-forwarder
cmd /v:on /c "node --import tsx src/main.ts --config <temp.yaml> --self-check >nul 2>nul & echo EXIT=!errorlevel!"
```

| 配置 | 构造 | 期望 | 实测退出码 | stderr 违规码（完整输出摘录见 §附录B） |
|---|---|---|---|---|
| a | Telegram 目标 + 合规段全省略（闸门全关） | 78 | **EXIT=78** | `CROSS_BORDER_GATE_CLOSED`（并逐条列出 enabled=false / 缺 operator / 缺 acknowledgedAt / selfMessagesOnlyConfirmed=false） |
| b | Telegram 目标 + `telegramCrossBorder.enabled: true`，缺 operator/acknowledgedAt/selfMessagesOnlyConfirmed | 78 | **EXIT=78** | `CROSS_BORDER_ACK_INCOMPLETE` |
| c | `contentOwner: third-party` + receiver 齐全 + 同意机制默认关闭 | 78 | **EXIT=78** | `THIRD_PARTY_CONSENT_DISABLED（路由 colleague-wx-to-qq）` |
| d | 微信源 `chatType: group` | 78 | **EXIT=78** | `WECHAT_GROUP_SOURCE_FORBIDDEN（路由 wx-group-source）` |
| e | `gateway.baseUrl: https://ilinkai.weixin.qq.com` | 78 | **EXIT=78** | `DIRECT_PLATFORM_ENDPOINT` |
| 默认 | `config/config.example.yaml` | 0 | **EXIT=0** | 打印 `自检通过：配置与合规前置检查均未发现问题（未连接网关、未发送任何消息）` |

补充（非甲方要求，用于确认"闸门确实可开、失败原因确实隔离"）：

| 配置 | 构造 | 实测 | 说明 |
|---|---|---|---|
| f | 仅 Telegram **作为源**（入境边），无任何确认 | **EXIT=0** | 横幅显示 `出境边=0 入境边=1`，证明入境路由不触发闸门（保留点，见 §2-4） |
| g | third-party + 告知要素齐全 + `thirdPartyConsent.enabled: true` | **EXIT=0** | 合法路径可启动，说明 c 的 78 不是"一刀切" |
| h | Telegram 目标 + 四要素 + 正确 `riskNoticeVersion` | **EXIT=0** | 闸门四要素齐备时确实放行 |
| i | 同 h 但 `riskNoticeVersion: "2020-01-01.v0"`（陈旧版本） | **EXIT=78** | `CROSS_BORDER_ACK_INCOMPLETE`，原因行明确：版本不一致需重新确认 |
| — | 默认配置但**不设** `EASYBOT_TOKEN` | **EXIT=78** | `GATEWAY_TOKEN_MISSING` |
| — | 配置文件不存在 / 未知字段 `routes[0].force` | **EXIT=78** | `CONFIG_INVALID`（不是 exit 1，仍按合规失败处理） |
| — | 违规配置**不加** `--self-check`（真实启动路径） | **EXIT=78** | 说明不是只有自检模式才拦，正常启动同样在建立任何连接前拒绝 |

### 3.2 绕过尝试（全部失败）

| 尝试 | 结果 |
|---|---|
| `--force` | `[FATAL] … 未知参数：--force`，**exit 1**，不启动（`main.ts:47-77` 只认 `--config/-c`、`--self-check`、`--help/-h`） |
| `--skip-compliance`、`--skip-check` | 同上，exit 1 |
| 环境变量 `SKIP_COMPLIANCE`、`COMPLIANCE_SKIP`、`IM_FORWARDER_FORCE`、`IM_FORWARDER_SKIP_COMPLIANCE`、`BYPASS_COMPLIANCE`、`EASYBOT_SKIP_COMPLIANCE` 全设=1 后跑配置 a | 仍 **EXIT=78**（`src/` 中 `process.env` 只用于读取令牌，见 `main.ts:90,105,156`、`preflight.ts:58`） |
| 静态搜索 `--force|--skip|bypass|skip-check|no-compliance|ignore-compliance` | `src/`、`scripts/` 仅命中 2 处注释（`preflight.ts:10,274` 自称"没有绕过开关"），无实现 |
| 注释掉检查分支 | 逐文件通读 22 个 src 文件，`runPreflight()` 在 `main.ts:105` 无条件调用；无 `if (…) skip` 分支 |
| 配置省略 `compliance` 段 | 默认值全关（`schema.ts:204-234`），等价于最保守 |
| YAML 重复键（两个 `routes:`） | **EXIT=78** `Map keys must be unique at line 12`（yaml 解析层拒绝） |
| YAML merge key（`<<:`） | **EXIT=78**，schema 报 `Unrecognized key(s) in object: '<<'`（默认 schema 不展开 merge，且 strict 拒绝） |
| `enabled: "true"`（字符串）/未知字段 | schema 拒绝 → **EXIT=78** |

> 唯一找到的"防护边界绕过"不在启动闸门，而在"禁止直连平台域名"的域名黑名单：`https://ilinkai.weixin.qq.com./api`（尾随点）实测 **EXIT=0**。详见 §8.1-F1。它不产生任何登录能力，也不绕过 §2 的 1-8 条判定，但会使 COMPLIANCE.md 3.1③/8-1 的"preflight 会拒绝 baseUrl 指向 ilinkai"这句话在构造场景下不成立。

---

## 4. 同意机制穿透测试

### 4.1 方法

临时脚本 `%TEMP%\imf-audit-20261018\poc-consent.mts` 直接调用项目真实模块（`loadConfig` → `compileMatrix` → `ConsentService` + `ConsentStore` + `LoopGuard` + 真实 `Forwarder`），注入假网关（只记录发送、不联网），构造两类配置：

- PoC 配置：同一微信私聊会话 `wechat:wxid_colleague` 命中**两条** third-party 路由（→ `qq:10002`、`qq:10003`），`thirdPartyConsent.enabled: true, persist: false, noticeCooldownMs: 0`；
- 以及手工伪造的 `consent.json`（本地生成，用于验证存储层完整性）。

### 4.2 结果

| 场景 | 结果 | 判读 |
|---|---|---|
| P1 本服务自身账号（`senderIsSelf: true`）发「同意转发」 | `["skipped_self"]`，`grant=false` | **拦住**：`forward.ts:72-81` 的 `senderEligibleForConsent` 要求 `!senderIsSelf && !senderIsBot && chatType==="private"` |
| P2 其它 bot（`senderIsBot: true`）发「同意转发」 | `["skipped_bot"]`，`grant=false` | **拦住**：不会替他人写入同意记录 |
| P3 正文内嵌「我同意转发这条消息」 | `["blocked_consent_pending","blocked_consent_pending"]`，`grant=false` | **拦住**：`classifyCommand` 是整条精确匹配（`consent.ts:112-126`），不是包含匹配 |
| P4 `senderIsBot: false`（网关未把该发送方标记为 bot）的「同意转发」 | `["consent_recorded"]`，`grant=true` | 机制按设计放行。**这说明资格判定完全信任网关上报的 `senderIsSelf/senderIsBot`**（缺省 false，`mapping.ts:183-184`）：若网关漏报机器人标志，其它 bot 可代写同意记录 |
| P5 授权后一条普通正文 | `["forwarded","forwarded"]`，目标 `[qq:10002, qq:10003]` | **一次同意同时授权了同一会话的两条 third-party 路由**：实际粒度是"会话"（`consent.ts:48-50`），不是 COMPLIANCE.md:93 所称的"会话 + 链路" |
| F1 手工伪造 `consent.json`（未来的 `expiresAt`、合法的 noticeVersion） | `hasGrant=true`，`recordCount=1` | `consent-store.ts:78-104` 只做浅结构校验，**无签名/HMAC**，本地可伪造同意 |
| F2 在伪造记录里注入额外字段 `injectedExtra` | 重写后仍保留 | `load()` 不校验 record 内部字段集合，注入内容会随 `flush()` 原样落盘 |

### 4.3 结论（针对验收标准 5）

- 甲方设想的滥用场景——"本服务自己的账号或另一个 bot 发一句「同意转发」，替他人写入同意记录"——**在网关正确上报 `senderIsSelf/senderIsBot` 时被有效阻断**（P1/P2；项目自带 59 个测试中也各有一条同名断言，本次实跑通过）。
- 残留：资格判定与 `contentOwner` 归属均属"自述/网关上报"性质，代码无法独立验证；同意记录文件无完整性保护。二者都已在 COMPLIANCE.md 的"能力边界"中部分披露（身份不可验证），但"同意记录可被本地伪造"未披露。见 §8。

---

## 5. 依赖与关键词审计明细

### 5.1 依赖审计（独立于项目自带 scan）

`package.json`：

- `dependencies` = `ws ^8.18.0`、`yaml ^2.5.1`、`zod ^3.23.8` —— 与甲方要求一致，无多余项。
- `devDependencies` = `@types/node`、`@types/ws`、`tsx`、`typescript` —— 一致。
- 无 `peerDependencies` / `optionalDependencies` / `bundledDependencies`。

`package-lock.json`（lockfileVersion 3）：36 个 `node_modules/*` 条目，逐条核对依赖边后**全部可解释**：

| 包 | 来源 | 依赖边 |
|---|---|---|
| `ws`、`yaml`、`zod`、`typescript` | 直接依赖 | 无 |
| `tsx` | dev | → `esbuild` |
| `esbuild` + 26 个 `@esbuild/<platform>` | tsx 依赖 | 无 |
| `fsevents` | 可选（macOS） | 无 |
| `@types/node` | dev | → `undici-types` |
| `@types/ws` | dev | → `@types/node` |
| `undici-types` | @types/node 依赖 | 无 |

结论：**无 `node-telegram-bot-api`、`telegraf`、`telethon` 类、`wechaty`/`padlocal`/`wechatferry`、`napcat`/`oicq`/`go-cqhttp`、`sqlite`/`redis`/`bull`/`amqplib` 等任何可疑包**；未发现 postinstall/脚本注入（lock 中无 `hasInstallScript` 相关异常）。未审计 `node_modules` 内文件内容与供应链完整性（见 §8.2）。

### 5.2 全仓关键词审计（独立 grep，区分"政策声明"与"实现"）

扫描词：`telethon|pyrogram|mtproto|tdlib|api_hash|session_string|userbot|ilinkai|ilink_bot|bot_token|qrcode|itchat|wechaty|padlocal|wechatferry|wcferry|com.tencent.mm|console.log|group_msg`（大小写不敏感）。

**`src/**` 命中 5 处，全部判定为"合规命中"：**

| 位置 | 内容 | 判定理由 |
|---|---|---|
| `src/config/load.ts:44` | 禁用键正则 `/bot_?token|ilink|qrcode|login_?token|scan_?code/i` | 这是**防御定义本身**：配置里出现这些键会被拒绝启动（`load.ts:116-119`）。不是能力实现 |
| `src/config/load.ts:45` | 上述规则的中文原因说明 | 注释/字符串，政策声明 |
| `src/config/load.ts:52` | 禁用键正则 `/telethon|pyrogram|mtproto|api_?hash|session_?string|userbot/i` | 同上，防御定义 |
| `src/compliance/gates.ts:20` | `host: "ilinkai.weixin.qq.com"` 在黑名单数组内 | **防护定义**：用于拒绝直连（`directPlatformHostViolation`）。不是调用该域名 |
| `src/gateway/contract.ts:11` | 注释"本仓库不存在任何 userbot（MTProto/Telethon/Pyrogram）代码路径" | 注释/政策声明 |

`src/**` 中 `console.log` = **0 处**（`src/` 全部输出经 `Logger` 白名单或启动横幅的 `process.stdout.write`；`scripts/` 中也无实际 `console.log(` 调用，仅扫描器的注释/字符串里出现该词）。`group_msg` = **0 处**（群聊以 `chatType` / `group` 字段表达，不是微信协议字段）。

**其它目录命中，全部为文档/测试/扫描器规则：**

| 位置 | 判定 |
|---|---|
| `scripts/compliance-scan.mjs:36-54` | 扫描器自身的禁用词规则、依赖白名单、注释说明 |
| `test/preflight.spec.ts:302,352-373` | **负向测试**：断言"baseUrl=ilinkai 必须被拒""配置出现 bot_token 必须报错" |
| `config/config.example.yaml:8` | 注释"严禁写入凭据"；`tokenEnv: "EASYBOT_TOKEN"` 只是环境变量名 |
| `README.md:17,25,104`、`COMPLIANCE.md:20,163,167,182-189,336-338,353`、`docs/*`、`.env.example` | 政策声明与条款说明，不是实现 |

**补充关键词扫描（未在甲方清单内）**：`login|sign.?in|qrcode|cookie|napcat|onebot|cqhttp|botfather|bot_api|tdlib|tdata` —— `src/` 命中均为注释/横幅文案/禁用键正则；`src/` 无 `child_process`、`node:net`、`node:dns`、`node:http(s)`、`eval(`、`new Function`、`require(`。全仓库（除 `node_modules`）无 `*.py`、`*.session`、`*telethon*`、`*pyrogram*`、`*mtproto*` 文件。

**网络出口审计**：`src/` 中只有 3 处网络相关调用——`client.ts:183 fetch(this.endpoint)`（endpoint = 配置 `baseUrl + send.path`）、`events.ts:126 new WebSocket(this.wsUrl)`（= 配置 `eventsUrl`）、`main.ts:205` 构造事件源。没有任何平台官方 SDK/域名硬编码调用（`gates.ts` 中的官方域名只用于**黑名单拦截**）。

### 5.3 项目自带 `compliance:scan` 的局限（本次不依赖它下结论）

- 只扫 `src/**/*.ts` 与 `scripts/**/*.ts`（`compliance-scan.mjs:30`），**不扫** `config/*.yaml`、`test/**`、`docs/**`、`package-lock.json`、`*.mjs`；
- 先剥离注释再匹配（`:117-166`），因此"注释里的政策声明"不会误报——这是合理的，但也意味着**把实现写进注释**不会被发现；
- 命中 `FORBIDDEN|BLOCKLIST|BLACKLIST|DENYLIST|DENY_` 常量名内部的词一律豁免（`:168-189`）：若有人把违规字符串放进同名常量数组，扫描器会静默豁免（本项目当前无此情况，本次人工逐处核对过）；
- 无法识别字符串拼接（`"tele"+"thon"`）、Base64/编码后的实现；依赖检查只比对 `package.json`，不比对 lockfile（本次已独立核对 lockfile）。

---

## 6. 日志与持久化审计明细

### 6.1 日志（验收标准 6）

**防线结构（`src/observability/logger.ts`）**：

1. 白名单 12 个字段：`event, routeId, sourcePlatform, targetPlatform, status, kind, scope, errorCode, latencyMs, count, attempt, host`（`:19-32`）；
2. 写入前按白名单逐字段 `pick`，**非白名单键直接丢弃**（`:100-106`），且 `sanitizeLogValue` 对对象/数组返回 `undefined`；
3. 字符串值去控制字符；长度 >120 时整体替换为 `[omitted:N]`，**不保留前缀**（`:117-133`）；
4. `sink` 默认 `process.stdout.write`（`:69`），无文件写入。

**正文流向核查**：全仓 `.text` 相关引用共 15 处，逐一确认：

- `forward.ts:77` → `consent.classifyCommand(message.text)`（只做整条关键词匹配，不记录）；
- `forward.ts:308-314` → `renderForTarget` → 出站请求体 `segments`；
- `forward.ts:357` → `loopGuard.rememberFingerprint`（HMAC 摘要，仅内存）；
- `loop-guard.ts:106-107` → HMAC（盐每进程随机，`loop-guard.ts:51,117-120`）；
- `mapping.ts:164-171` → 归一化读取；`contract.ts:74` / `transform.ts:88` / `client.ts:169` 为字段路径/渲染/请求体。

**没有任何一条**把 `text` 传入 `Logger`、`process.stdout.write` 或 `process.stderr.write`。`logger.ts` 的白名单里没有 `text/content/message/body` 之类的键；`LogFields` 类型层也禁止。59 个测试中 `test/redaction.spec.ts` 用 canary 文本断言"所有日志行不含正文及任意 8 字子串"，本次实跑通过。

**错误路径**：`client.ts` 主动 `discardBody`（`:71-78,206-216`），网关响应体/`errorCode` 不透传（`:238-241`）；`events.ts` 遇到坏帧只上报 `ws_bad_frame`、不打印帧内容（`:181-202`）；`main.ts:247-256` 的 fatal 处理只打印稳定错误码与错误类型。

**有保留的发现（非正文，但属于"输出面"）**：

- 前置检查失败信息会打印**目标会话 ID**（如 `THIRD_PARTY_NOTICE_MISSING` 的 `message` 含 `target.platform:target.conversationId`，`preflight.ts:113-124`；`RouteMatrixError` 的"重复路由边"也含会话 ID，`matrix.ts:132-137`）。这与 README §六"没有会话 ID"的绝对表述存在口径差异——它走的是 stderr/启动横幅，不是 `Logger`，且不含正文；
- `--self-check` 会打印 `gateway.baseUrl`（`load.ts:156`）。若使用者把凭据写进 URL userinfo，会被打印；配置层不阻止（不属正文泄漏）。

### 6.2 持久化

- 全仓（除 `node_modules`）`writeFile|appendFile|createWriteStream|sqlite|better-sqlite|redis|queue|localStorage|indexedDB` 审计：**唯一写入点**是 `src/compliance/consent-store.ts:131-137` 的 `flush()`（临时文件 + `renameSync` 原子替换），写入内容为 `{version, records}`：`scopeKey / platform / conversationId / grants{noticeVersion, grantedAt, expiresAt} / updatedAt`——**无正文、无 messageId、无转发内容**。
- 无数据库、无队列、无磁盘缓存、无日志文件落盘；日志只到 stdout，由守护进程决定去向。
- `data/` 目录：本副本中已存在但为**空目录**（创建时间早于本次审计；`loadConfig` 在 `persist: true` 时会无条件 `mkdirSync`，`load.ts:145-147`，因此跑测试/自检会在仓库内创建/复用该目录）。`data/` 在 `.gitignore` 中排除（`.gitignore:6`），同时排除 `config/config.yaml` 与 `.env*`（`:7-12`）。
- 但本副本**不是 git 仓库**（`.git` 不存在），因此无法验证 `.gitignore` 在真实仓库中的实际生效状态（见 §8.2）。

---

## 7. 文档实质性质检（README / COMPLIANCE / docs）

### 7.1 README 风险披露逐条核对

| README 声明 | 代码/配置证据 | 结论 |
|---|---|---|
| 首段"禁止用于商业场景、收费服务或付费托管"，位于安装步骤之前（第 3-10 行，安装在第 91 行起） | LICENSE 第 2 节 Commons Clause + 第 3 节中文补充；启动横幅 `main.ts:119-126` 固定打印同一句 | ✔ 落地 |
| 微信只能走官方 iLink，不含登录/扫码/Cookie/协议逆向 | 无相关代码；`config/load.ts:38-55` 禁用键；`gates.ts:18-55` 域名黑名单 | ✔ 已写明且与代码一致 |
| 微信仅私聊、不调用好友目录/撤回/历史 | `policy.ts:60-62`、`gates.ts:154-199`；全仓无相关 API 调用 | ✔ |
| QQ/NapCat 非官方通道、登录验证/掉线/封号风险、必须用小号 | `preflight.ts:238-240` 启动横幅固定打印；README 第 21-23 行 | ✔ |
| Telegram 仅 Bot API，严禁 MTProto userbot/Telethon/Pyrogram | 依赖/代码/禁用键/扫描器四层证据 | ✔ |
| 数据出境风险 + PIPL 38/39 + 默认关闭 + 四项确认 | `defaultComplianceSettings()` 全关；`evaluateCrossBorderGate` 五项校验；实测 exit 78；COMPLIANCE 5.2 | ✔（"四项确认"另加版本校验，文档已单列） |
| 境内网络访问合规、不提供规避方案 | 仓库无代理/隧道代码；README 第 34-36 行 | ✔ |
| 免责条款、非法律意见 | README 第 37-41 行；LICENSE 第 1 节 AS IS | ✔ |

### 7.2 COMPLIANCE.md 覆盖度

- **PIPL 第 23 条**（2.4）：告知六要素 → `receiver.*` 配置强制（`schema.ts:32-47`、`preflight.ts:113-124`）；单独同意 → 会话内关键词流程（`consent.ts`、`forward.ts:113-199`）；均有代码位置。
- **第 38 条**（2.5）：默认 0 条出境边、闸门、`CROSS_BORDER_*` 错误码、`riskNoticeVersion` 版本失效；均给到 `gates.ts` / `cross-border.ts` / `preflight.ts` / `schema.ts` 位置。
- **第 39 条**（2.6）：两次独立同意（`requiredScopes` domestic + cross-border）、告知文案（`notify.ts:54-69`）、顺序强制（`forward.ts:169-183`）；给到代码位置。
- **微信 ClawBot 条款**（3.1）：官方通道、非商业、仅私聊、未开放能力、代码证据；与代码一致。
- **NapCat 风险**（3.2）：定性、MUST 小号、不规避风控；"限速之外"表述见 §7.3。
- **Telegram 仅 Bot API 及排除 userbot 的理由**（3.3）：条款/权限/凭据三条理由 + 代码证据；成立。
- **"不涉及"场景表**（§4）：逐条为判断结论（非遗漏），抽查均与代码一致（无群聊、无媒体、无好友目录、无历史、无画像、无代理）。
- **每项是否给出代码位置或"本项目不涉及"的明确判断**：绝大多数给出；2.9（PIPLA）明确写"——（明确不涉及）"。**满足**甲方要求，但存在 §7.3 的失真。

### 7.3 文档失真清单（"写了但没落地/写错"，均非阻断）

| # | 文档表述 | 实际代码 | 影响 |
|---|---|---|---|
| D1 | `COMPLIANCE.md:93` "⑥ 同意按**会话 + 链路**粒度记录" | `consent.ts:48-50` 的 `scopeKey = platform:conversationId`，无 route/链路维度；PoC P5 证明一次同意覆盖同一会话的两条 third-party 路由 | 文档高估了同意粒度；PIPL 单独同意在"多接收方"场景下可能被质疑 |
| D2 | `docs/CONSENT-FLOW.md:194` 引用 `test/fixtures/config.third-party.yaml` | 该文件不存在（`test/fixtures/` 只有 `harness.ts`） | 文档操作步骤无法执行 |
| D3 | `docs/GATEWAY-CONTRACT.md:26` 引用 `src/policy/` | 实际目录为 `src/routing/` | 路径失真 |
| D4 | `COMPLIANCE.md:176` "不实现任何规避风控的行为（**限速之外**无任何对抗性设计）" | 代码中没有任何发送速率限制；只有重试退避（`client.ts:59-63`） | 暗示存在不存在的限速机制 |
| D5 | `docs/GATEWAY-CONTRACT.md:52` "Token 只从**配置**读取" | Token 值只从环境变量读取，配置里只有变量名（`schema.ts:71-72`、`main.ts:156`） | 与安全模型表述相反（实际更安全） |
| D6 | `docs/OPERATIONS.md:109` 审计命令读取 `logs\forwarder.log` | 服务只写 stdout，不写文件（`logger.ts:69`） | 该命令依赖使用者自行重定向；文档未说明 |
| D7 | `README.md:98` 提示 `Copy-Item .env.example .env` | 项目无 dotenv 加载器，`.env` 不会被读取 | 文档已标注"仅示意"，但容易误导 |
| D8 | `docs/GATEWAY-CONTRACT.md:295`"日志与诊断只允许出现消息 ID…" | `LOG_FIELD_WHITELIST` 中没有 messageId 字段 | 实际比文档更严格，无泄漏风险 |

另外发现 `src` 中 5 个合规工具函数/常量在生产路径未被调用（`isWechatPrivateOnly`、`crossBorderStartupBlocker`、`formatCrossBorderNotice`、`crossBorderTargets`、`endpointOf`；仅定义/导出，测试也未引用）。强制点实际在 `checkRouteShape` 与 `policy.ts`。不影响合规结论，但增加"文档指向了未生效函数"的维护歧义。

---

## 8. 残留风险与未覆盖项

### 8.1 本次发现的问题（按严重度排序）

**无阻断级（不可上线）问题。** 以下均不改变 §2 的 8 条结论，但甲方应知情并要求整改/披露：

| 编号 | 严重度 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| F1 | **中低** | `DIRECT_PLATFORM_ENDPOINT` 域名黑名单可被"尾随点"绕过：`gateway.baseUrl: https://ilinkai.weixin.qq.com./api` 实测 **EXIT=0**，同 `api.telegram.org.`、`weixin.qq.com.` 均绕过（`URL.hostname` 保留尾随点，`gates.ts:46-55` 用严格相等/后缀比较，未规范化）。这不会带来登录能力，但认证 Bearer Token 会被发往该域名，且 COMPLIANCE.md 3.1③/8-1 的"preflight 拒绝直连 ilinkai"被构造场景证伪 | 本次 §3.2 实测；`gates.ts:37-55` | 规范化 hostname（去尾随点、IDNA/小写）；或在文档中明确"黑名单为尽力而为，不是安全边界" |
| F2 | **低** | 同意记录 `data/consent.json` 无签名/完整性校验，本地手写即可伪造"已同意"（PoC F1）；`load()` 还允许记录内出现额外字段并原样重写（F2） | `consent-store.ts:78-104`；PoC | 增加 HMAC/校验和并在启动时校验；或在 COMPLIANCE 中显式披露"本地文件可被篡改，同意证明仅具内部可信度" |
| F3 | **低** | 同意粒度实际为"会话"，但 COMPLIANCE.md 写"会话 + 链路"；一次「同意转发」可授权同一会话的多条他人内容路由（PoC P5 命中 2 个目标） | `consent.ts:48-50`；`COMPLIANCE.md:93`；PoC P5 | 二选一：修正文档，或把 route/notice 维度纳入 `scopeKey`/`requiredScopes` |
| F4 | **低（信任边界）** | 同意指令资格完全依赖网关上报的 `senderIsSelf/senderIsBot`；字段缺失时默认 `false`（`mapping.ts:183-184`、`GATEWAY-CONTRACT.md:102-103`）。若网关漏报 bot 标志，其它 bot 的「同意转发」会被记录（PoC P4） | `forward.ts:72-81`；PoC P4 | 文档披露"资格判定依赖网关契约"；网关侧强制输出 `sender.isBot` 并在契约中列为必需字段 |
| F5 | **低（文档）** | §7.3 的 D1–D8 共 8 处失真/失效引用 | 见 §7.3 | 按表修正，并纳入 `npm run check` 的文档链接检查（当前 CI 不检查 Markdown 引用） |
| F6 | **提示（信任边界）** | 群聊硬门依赖网关推送的 `chatType` 与 `fieldMap` 映射；若网关把群聊误报为 `private`，或使用者把 `fieldMap.chatType` 指向恒为 `"private"` 的字段，硬门失效。本服务无法独立判断会话真实类型 | `policy.ts:60-62`、`mapping.ts:156-159`、`schema.ts:79-81` | 文档披露；网关契约要求 `chatType` 必填且可信；可考虑对微信源只接受白名单会话 ID |
| F7 | **提示** | `contentOwner` 是自述字段：使用者可把"他人的会话"标成 `self` 从而完全绕过同意机制。这是本设计的根本边界（文档 2.4/6.3 已部分声明"程序无法判断"） | `schema.ts:58`；COMPLIANCE §6.3 | 在 README 风险提示中把"contentOwner 自述不可验证"提升为显式风险条目 |
| F8 | **提示** | `loadConfig` 在 `persist: true`（默认）时无条件 `mkdirSync(dataDir)`，即使配置随后被合规检查拒绝，也会在仓库内创建 `data/`（本次审计前已存在空 `data/`）；测试/自检会复现该副作用 | `load.ts:145-147` | 可接受（已被 `.gitignore` 排除）；如需洁净交付可延后到 consent 真正启用时再建目录 |
| F9 | **提示** | 本次审计的副本**无 `.git`**，无法验证 `.gitignore` 在真实仓库中的生效状态、无法核对提交历史中是否曾出现正文/凭据 | 文件系统枚举 | 交付方应提供含 git 历史的仓库供复验 |
| F10 | **提示** | `scripts/compliance-scan.mjs` 的豁免机制按常量名匹配（`FORBIDDEN|BLOCKLIST|DENYLIST…`），同名常量内的禁用词会被整体豁免；且只扫 `src/scripts` 的 `.ts` | `compliance-scan.mjs:168-189,30` | 作为"自审"工具可接受；交付说明中应避免把它当作独立审计证据（本次已独立扫描） |

### 8.2 未覆盖项（必须向甲方说明的边界）

1. **未做动态网络行为观测**：本次未访问任何真实平台、未抓包。因此无法证明"运行时实际只连接网关地址"（只能从代码证明唯一出口是 `baseUrl/eventsUrl`）；也未观察 DNS 解析、TLS、代理环境变量等对实际出口的影响。
2. **未验证 EasyBot 网关本身的合规性**：微信 iLink 官方授权/扫码、NapCat 登录小号、Telegram Bot API 的调用与存储，全部在网关侧完成，不在本仓库。若网关使用非官方 iLink 通道或把消息落盘，本项目无法发现。这可能是整个系统中最大的合规未知项。
3. **未验证 Telegram 侧实际存储与境外接收方身份/联系方式真实性**；本项目只负责在配置里要求 `receiver.*` 字段。
4. **未验证微信 iLink(ClawBot) 与 NapCat 的当前官方条款文本**；文档中的条款描述以交付时为准，平台可能变更。
5. **未做真实进程端到端日志抓取**：验收标准 6 的依据是"代码路径审查 + 59 个测试中的 canary 断言"；未启动 mock 网关 + 真实进程长跑并抓 stdout 做独立 canary 对比。未做内存取证/核心转储分析（JS 运行时本就不保证内存擦除，文档已声明）。
6. **未审计 `node_modules` 内文件内容与包完整性哈希**：只核对了 lockfile 的依赖图与顶层包名。供应链层面（包内容被篡改、install 脚本）未验证。
7. **未做配置资源耗尽测试**：YAML 别名炸弹、超长配置、`fieldMap` 指向深路径等 DoS 面未测（配置属本地受控输入，风险较低）。
8. **未在真实 git 仓库/CI 环境验证**：本副本无 `.git`，`npm run check` 为本地执行；未验证 `.github/workflows/ci.yml` 实际跑通、也未验证 CI 的"禁止文件"守卫（`ci.yml:42-63`，其 `find` 显式跳过 `test/fixtures`，即该目录可藏 `.py`/`.session` 而不被该步骤发现——当前仓库无此类文件）。
9. **未评估法律实质**：本报告不判断部署行为是否满足 PIPL 第 38/39/55 条，只判断代码是否提供了所述机制。
10. **未覆盖的代码分支**：真实 WS 重连时序、网关 4xx/5xx 真实响应、长连接下的 consent 并发写入（单进程单线程，风险低）未做专项测试。

---

## 9. 最终结论

1. **是否达到"仅供技术研究、默认最保守、可被审计"的交付标准？**
   **基本达到。** 依据：默认配置仅含境内私聊链路、所有合规开关默认关闭、危险配置一律 exit 78 且无旁路开关、日志与持久化面收敛到白名单/元数据、文档把风险逐条落到代码位置。8 条验收标准中 5 条完全通过、3 条通过（有保留）。

2. **阻断级问题：无。** 未发现微信登录绕过、群聊处理、个人号 Telegram、默认放开他人内容、正文入日志或正文落盘中的任何一项。

3. **交付前建议整改（按优先级）**：
   1. 修复 F1（hostname 规范化）并在文档中修正"preflight 必然拒绝 ilinkai"的绝对表述；
   2. 修正 F3/D1 的同意粒度表述（或改代码粒度），避免"告知范围 = 实际授权范围"出现偏差；
   3. 披露 F2/F4/F6/F7 四个信任边界（同意记录可伪造、资格依赖网关标志、群聊判定依赖网关、`contentOwner` 自述）；
   4. 修正 §7.3 的 8 处文档失真，尤其是失效引用 D2/D3 与不存在的"限速" D4；
   5. 交付含 git 历史的仓库，并提供网关侧合规材料（iLink 授权方式、NapCat 账号类型、Telegram Bot 的存储策略），否则本审计的"未覆盖项 1/2"无法闭环。

4. **复审建议**：本次已覆盖全部 22 个 src 文件与全部 59 个测试用例；整改 F1-F5 后，只需按 §3 的 5 份黑盒配置 + §4 的 PoC 复跑即可确认回归。

---

## 附录 A：本次使用的临时配置（全部位于 `%TEMP%\imf-audit-20261018\`，未写入仓库）

| 文件 | 用途 |
|---|---|
| `a-tg-gate-closed.yaml` | Telegram 目标 + 闸门全关 → 78 |
| `b-tg-enabled-incomplete.yaml` | enabled=true 但缺三要素 → 78 |
| `c-thirdparty-consent-off.yaml` | third-party + 同意关闭 → 78 |
| `d-wechat-group.yaml` | 微信群聊源 → 78 |
| `e-ilinkai-baseurl.yaml` | baseUrl=ilinkai → 78 |
| `f-telegram-inbound-only.yaml` | 仅 Telegram 入境 → 0（保留点） |
| `g-thirdparty-consent-on-valid.yaml` | third-party 合法路径 → 0 |
| `h-tg-gate-open-valid.yaml` | 出境四要素齐备 → 0 |
| `i-tg-gate-stale-version.yaml` | 版本陈旧 → 78 |
| `host-*.yaml` ×9 | 域名黑名单变体（含尾随点绕过 → 0） |
| `yaml-duplicate-keys.yaml` / `yaml-merge-key.yaml` / `unknown-field.yaml` | YAML/schema 边界 → 均 78 |
| `poc-config.yaml` + `poc-consent.mts` + `poc-data/consent.json` | 同意机制穿透 PoC |

## 附录 B：关键命令输出摘录

```text
# a-tg-gate-closed.yaml（stderr）
[1] CROSS_BORDER_GATE_CLOSED
    问题：检测到 1 条目标平台为 Telegram 的出境路由（wx-to-tg），但出境闸门未完全打开。具体原因：
  - compliance.telegramCrossBorder.enabled = false（默认关闭，必须显式开启）
  - 缺少 compliance.telegramCrossBorder.operator（开通者署名）
  - 缺少 compliance.telegramCrossBorder.acknowledgedAt（确认时间戳）
  - compliance.telegramCrossBorder.selfMessagesOnlyConfirmed = false（必须确认仅转发本人自己的消息）
...
前提示：本项目的合规约束优先于功能需求。
本项目不提供 --force / --skip-compliance 之类的绕过开关。

# 默认配置（stdout）
──────────────────────────────────────────────────────────────
 im-forwarder · 微信(iLink) ↔ QQ(NapCat) ↔ Telegram(Bot API)
 仅供技术研究学习 · 禁止商业用途 / 收费服务 / 付费托管
──────────────────────────────────────────────────────────────
[COMPLIANCE] wechat   = 官方 iLink(ClawBot) · 仅私聊 · 经网关 | 本服务不含任何微信登录代码
[COMPLIANCE] qq       = NapCat + OneBot11 经网关 | 非官方通道 · 有登录验证/掉线/封号风险 · 必须用小号
[COMPLIANCE] telegram = 官方 Bot API 经网关 | 出境闸门：CLOSED
[COMPLIANCE] routes=2 edges=2 groups=1 | 出境边=0 入境边=0 | 他人内容路由=0 | 路由环=1
[COMPLIANCE] 正文持久化：禁止（无数据库/无队列/无磁盘缓存） | 正文日志：禁止（日志字段白名单） | 同意记录：未启用
...
自检通过：配置与合规前置检查均未发现问题（未连接网关、未发送任何消息）。

# 同意机制 PoC
P1 自身账号发「同意转发」: statuses=["skipped_self"] grant=false
P2 其它bot(senderIsBot=true)发「同意转发」: statuses=["skipped_bot"] grant=false
P3 正文内嵌关键词: statuses=["blocked_consent_pending","blocked_consent_pending"] grant=false
P4 未被网关标记为bot的「同意转发」: statuses=["consent_recorded"] grant=true
P5 授权后一条正文触发的目标: statuses=["forwarded","forwarded"] targets=[qq:10002,qq:10003]
F1 手写 consent.json 被接受: hasGrant=true recordCount=1
F2 注入的额外字段是否被原样保留: true
```

---

*本报告由独立审计会话生成；所有结论可依据 §1.2 的命令复现。行号引用基于本次审计时的 `D:\openclaw\im-forwarder` 工作副本。*

---

## 附录 C：整改记录（审计后由 Lead 复核补记）

> 审计报告完成后，交付方按 §8.1 与 §9.3 的建议做了整改。本附录记录"发现 → 处理 → 证据"，
> 供复审时逐条核对。整改后 `npm run check` 全绿（63/63 测试通过，新增 4 条回归用例）。

| 发现 | 处理方式 | 证据位置 |
|---|---|---|
| **F1** 域名黑名单可被尾随点绕过 | **已修复代码**：`hostnameOf()` 先小写化再去掉所有尾随点（`ilinkai.weixin.qq.com.` ≡ `ilinkai.weixin.qq.com`）；并在文档中把该黑名单明确为"减少误接的辅助防线，不是安全边界" | `src/compliance/gates.ts › hostnameOf`；回归用例 `test/regression-audit.spec.ts`（3 条）；黑盒复测 `direct-ilink-trailing-dot EXIT=78` |
| **F2** 同意记录无签名、可伪造 | **不修代码，改为显式披露**（单机自用工具的定位决定：新增签名只会把密钥管理问题转移到本地） | `COMPLIANCE.md` §6.3 新增"同意记录可被本机篡改"行；§10 第 8 条；`README.md` 已知限制第 8 条 |
| **F3 / D1** 同意实际是会话粒度、文档写成"会话+链路" | **已改代码 + 改文档**：`ConsentGrant` 增加 `routes?: string[]`；`grant()` / `hasGrant()` / `check()` 支持 `routeId`，同意按链路累计（同一会话多条他人内容路由需各自确认）。旧记录无 `routes` 时按"全部路由"解释（向后兼容，已在文档提示清空重建） | `src/compliance/consent-store.ts › ConsentGrant.routes`；`src/compliance/consent.ts › grant / hasGrant / check`；`src/pipeline/forward.ts` 调用点；回归用例 F3（断言只发往已同意链路）；`COMPLIANCE.md` §2.4⑥、§6.2；`docs/CONSENT-FLOW.md` §3、§4 |
| **F4** 同意资格依赖网关 `senderIsSelf/senderIsBot` | **不修代码，改为显式披露**：资格判定在 `forward.ts::handle` 已收紧为"非自身 + 非机器人 + 私聊"，但字段值本身来自网关契约，程序无法独立验证 | `COMPLIANCE.md` §6.3 新增行 + §10 第 9 条；`README.md` 已知限制第 9 条；另在 `docs/GATEWAY-CONTRACT.md` 要求网关把 `sender.isBot` 作为必填可信字段输出 |
| **F5 / D1–D8** 8 处文档失真 | **逐条修正**：D1 见上行；D2 删除失效的 `test/fixtures/config.third-party.yaml` 引用，改为通用说明；D3 `src/policy/` → `src/routing/`；D4 删除不存在的"限速"表述；D5 明确 Token 只从环境变量读取；D6 说明日志只写 stdout、需自行重定向；D7 明确 `.env` 不会被加载；D8 说明 `messageId` 也不在日志白名单内 | `docs/CONSENT-FLOW.md`、`docs/GATEWAY-CONTRACT.md`、`docs/OPERATIONS.md`、`README.md` |
| **F6** 群聊判定依赖网关 `chatType` | **披露**（无法在代码内消除：本服务看不到平台会话真实类型） | `COMPLIANCE.md` §6.3 新增行；`docs/GATEWAY-CONTRACT.md` §边界声明 3 已要求网关保证 |
| **F7** `contentOwner` 自述可绕过同意 | **披露**：从"部分声明"提升为显式风险条目 | `COMPLIANCE.md` §6.3 + §10 第 9 条；`README.md` 已知限制第 7 条 |
| **F8** `loadConfig` 无条件创建 `data/` | **已修复代码**：仅在 `thirdPartyConsent.persist === true && enabled === true` 时创建（`preflight` 同步收紧） | `src/config/load.ts`；`src/compliance/preflight.ts` §6 |
| **F9** 无 git 历史可验证 | **未处理**（本地副本非 git 仓库）。`.gitignore` 已就位；交付方可自行 `git init` 后纳入版本控制 | `.gitignore` |
| **F10** `compliance-scan` 属自审工具 | **定位澄清**：本报告即为独立审计证据；CI 另设"禁止文件名"守卫 | `.github/workflows/ci.yml`；`scripts/compliance-scan.mjs` 输出已声明局限 |

### C.1 整改后的复跑结果（Lead 执行）

```text
npm run check            → exit 0
  tsc --noEmit           → exit 0
  compliance:scan        → exit 0（23 个 .ts，0 命中，7 处豁免逐条打印）
  npm test               → 63 tests / 63 pass / 0 fail（新增 test/regression-audit.spec.ts ×4）

黑盒复测（cmd /v:on 读真实退出码）：
  default-ish                 EXIT=0      # 默认保守配置
  tg-gate-closed              EXIT=78     # 出境闸门全关
  tg-ack-incomplete           EXIT=78     # enabled=true 但确认不全
  wechat-group                EXIT=78     # 微信群聊源
  third-party-no-consent      EXIT=78     # 他人内容 + 同意关闭
  direct-ilink-trailing-dot   EXIT=78     # F1 回归：尾随点不再绕过
  direct-ilink                EXIT=78     # 直连官方域名
```

### C.2 仍未闭环的事项（与 §8.2 一致）

1. 网关侧合规材料（iLink 授权方式、NapCat 账号类型、Telegram 的存储策略）——不在本仓库可控范围；
2. git 历史与提交审计 —— 交付时可按需补充；
3. 动态抓包观测 —— 本次仅静态 + 黑盒进程级验证；
4. F2/F4/F6/F7 属信任边界，只能披露、不能在代码内消除。

**复审建议**：按 §3 的 5 份黑盒配置 + 本附录 C.1 的 7 条用例即可确认回归。
