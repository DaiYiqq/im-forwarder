# 运维清单（上线前 / 日常 / 应急）

> 这不是"装完就能跑"的说明书，而是一份**上线前必须逐项打勾**的清单。
> 大多数合规事故不是代码写错，而是"以为配好了"。

---

## A. 上线前 · 法律与平台侧（按顺序）

- [ ] **A1. 确认用途属于非商业**
      微信 iLink(ClawBot) 授权限于非商业目的；LICENSE 亦禁止收费/付费托管/转卖。
      只要你的使用会给任何人带来收入（含"内部工具但对外收费"），就停下。
- [ ] **A2. 确认只转发自己的消息**
      默认路由应全部是 `contentOwner: self`，即"你 ↔ 你的另一个账号"。
      只要涉及他人，就转 A3，不要跳过。
- [ ] **A3. 如涉及他人内容：完成告知—同意机制**
      `thirdPartyConsent.enabled: true`，并为每个目标补齐 `receiver` 六要素。
      逐项核对：接收方名称、联系方式、处理目的、处理方式、信息种类、保存期限。
      详见 [CONSENT-FLOW.md](CONSENT-FLOW.md)。
- [ ] **A4. 如涉及 Telegram：完成出境合规自评**（本工具不代做）
      - [ ] 第 38 条路径三选一：安全评估 / 保护认证 / 标准合同（或确认属豁免情形）
      - [ ] 第 39 条告知：境外接收方名称、联系方式、目的、方式、种类、权利行使方式
      - [ ] 第 39 条单独同意：对本人（或他人）取得独立同意
      - [ ] 第 55/56 条 PIPIA：完成评估并**保存报告至少三年**
      - [ ] 明确"仅转发本人消息"（配置里 `selfMessagesOnlyConfirmed: true` 是承诺，不是证明）
- [ ] **A5. 确认网络接入合法**
      中国大陆访问 Telegram 受相关法律法规约束；本项目不提供也不建议任何规避方案。
- [ ] **A6. 确认群聊不在范围内**
      本项目任何平台的群聊都会被拒绝。若业务确实需要群聊，请改用其它合规方案。

---

## B. 上线前 · 技术侧

- [ ] **B1. 使用专门的小号登录 QQ（NapCat）**
      严禁主力账号。封号风险由你承担；不接受"先试试主力号"。
- [ ] **B2. EasyBot 网关已就绪**
      - 微信：官方 iLink(ClawBot) 通道授权完成（由网关侧扫码/授权）
      - QQ：NapCat 已登录小号，OneBot 11 可用
      - Telegram（可选）：BotFather 机器人已创建并接入网关
      - 网关的 REST 发送与 WS 事件两个端点均可访问
- [ ] **B3. 令牌只放环境变量**
      `$env:EASYBOT_TOKEN = "..."`，不要写进 `config/config.yaml`、不要提交 `.env`。
      配置加载器会拒绝任何形似 cookie / bot_token / ilink_* / qrcode / MTProto 的键。
- [ ] **B4. 配置自检通过**
      ```powershell
      npx tsx src/main.ts --config config/config.yaml --self-check
      # 必须 exit 0；若 78，按提示逐条修（没有 --force）
      ```
- [ ] **B5. 核对网关契约**
      按 [GATEWAY-CONTRACT.md](GATEWAY-CONTRACT.md) 核对 `gateway.baseUrl / eventsUrl / send.path / fieldMap`，
      尤其 `data.conversation.type` 是否真能取到 `private`。
- [ ] **B6. 会话 ID 与真实 ID 一致**
      `conversationId` 必须是网关事件里出现的**原始 ID**，不是昵称/备注。
      核对方法：在网关侧看一条真实事件（本服务不打印会话 ID，属有意设计）。
- [ ] **B7. 质量门禁全绿**
      ```powershell
      npm run check    # typecheck + compliance:scan + 全量测试
      ```
- [ ] **B8. 进程守护**
      用 systemd / Windows 服务 / pm2 托管；**不要**用 `npm start` 前台长期跑。
      注意：守护进程不得开启"崩溃时 dump 内存"（会落盘正文）。
- [ ] **B9. 磁盘与备份**
      `data/` 目录只有同意元数据；备份它即可（不要备份日志里的任何内容——日志本来就没有正文）。
      确认 `data/` 与 `config/config.yaml` 不在版本控制中（`.gitignore` 已处理）。

---

## C. 启动与观察

```powershell
$env:EASYBOT_TOKEN = "..."
npx tsx src/main.ts --config config/config.yaml
```

启动横幅应显示（示例）：

```
──────────────────────────────────────────────────────────────
 im-forwarder · 微信(iLink) ↔ QQ(NapCat) ↔ Telegram(Bot API)
 仅供技术研究学习 · 禁止商业用途 / 收费服务 / 付费托管
──────────────────────────────────────────────────────────────
[COMPLIANCE] wechat   = 官方 iLink(ClawBot) · 仅私聊 · 经网关 | 本服务不含任何微信登录代码
[COMPLIANCE] qq       = NapCat + OneBot11 经网关 | 非官方通道 · 有登录验证/掉线/封号风险 · 必须用小号
[COMPLIANCE] telegram = 官方 Bot API 经网关 | 出境闸门：CLOSED
[COMPLIANCE] routes=2 edges=2 groups=1 | 出境边=0 入境边=0 | 他人内容路由=0 | 路由环=1
[COMPLIANCE] 正文持久化：禁止（无数据库/无队列/无磁盘缓存） | 正文日志：禁止（日志字段白名单）
──────────────────────────────────────────────────────────────
```

**建议截图存档**：它同时是"当前合规配置状态"的证据。

### 退出码

| 码 | 含义 | 处理 |
|---|---|---|
| 0 | 正常退出 | —— |
| 78 | 配置/合规前置检查未通过 | 按打印的整改建议修改；**没有** `--force` |
| 1 | 运行期错误 | 看日志 `errorCode`（不含正文） |

---

## D. 日常运维

### D1. 日志审计（每周一次）

```powershell
# 0) 本服务只把结构化日志写到 stdout，**不写文件**。
#    作为服务运行时请自行重定向（示例）：
New-Item -ItemType Directory -Force logs | Out-Null
npm start *>> logs\forwarder.log

# 1) 确认日志里没有正文：字段只有白名单键（见 src/observability/logger.ts）
Get-Content logs\forwarder.log -Tail 200 | ForEach-Object { $_ | ConvertFrom-Json } |
  Select-Object ts,event,status,routeId,sourcePlatform,targetPlatform | Format-Table

# 2) 异常告警信号
#    send_failed 比例升高  → 网关/会话 ID/风控
#    blocked_consent_pending 突增 → 有人尝试在未同意链路上发消息（应在设计内）
#    gateway_http_4xx  → 鉴权或目标会话错误
```

### D2. 同意记录维护

```powershell
# 查看当前有多少条同意记录（只有元数据）
Get-Content data\consent.json -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty records | Get-Member -MemberType NoteProperty |
  Measure-Object | Select-Object Count

# 清理过期/全部撤回
Remove-Item data\consent.json    # 重启后所有会话需要重新同意
```

### D3. 回环检查

如果发现"同一条消息被转发两次"：

1. 确认网关是否在发送响应里返回 `messageId`（不返回时只有指纹层兜底）；
2. 不要通过"关掉回环防护"来解决 —— 配置会强制要求 `loopGuard.enabled: true`（存在环时）；
3. 检查是否有人把同一消息同时配了多条目标边。

### D4. 升级流程

```powershell
git pull
npm ci
npm run check                       # 必须全绿
npx tsx src/main.ts --self-check    # 必须 exit 0
# 重启服务；观察 5 分钟 send_failed 比例
```

---

## E. 应急

| 场景 | 动作 |
|---|---|
| 疑似账号被风控/封禁（QQ） | 立即停服务 → `stop`；换小号；**不要**反复重登 |
| 怀疑消息进入了不该去的会话 | 停服务 → 检查 `routes` 与 `group` → 修正配置 → `--self-check` 通过再启 |
| 有人要求撤回其信息 | 让对方回复「撤回同意」；或删除 `data/consent.json` 并重启；已转发副本需在对方平台手动处理 |
| 令牌泄漏 | 在网关侧重置令牌 → 更新环境变量 → 重启；本服务不存令牌，无需清理本地 |
| 配置被人改动 | 用 `--self-check` 看 diff 的合规结论；git 历史中应有 `config/` 变更审查记录 |
| 需要临时全停 | `Ctrl+C`（SIGINT）会优雅关闭 WS 连接后退出 |

---

## F. 绝对不要做的事

1. ❌ 开启任何平台的群聊路由 —— 会被拒绝启动，且本来就不合规；
2. ❌ 把 `contentOwner` 写成 `third-party` 却不看告知文案；
3. ❌ 为了让 Telegram 跑起来而随意填写 `acknowledgedAt`（那就是伪造留痕）；
4. ❌ 把日志级别调到 `debug` 就以为"能看到内容" —— 本服务**没有**打印正文的代码路径，调级别也不会出现；
5. ❌ 给项目加数据库/队列"提升可靠性" —— 那会持久化正文，直接违反需求第 8 条；
6. ❌ 在 README 之外传播"这是合规工具"的说法 —— 它只是**降低越界可能性**的技术约束。
