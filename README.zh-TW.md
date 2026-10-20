# im-forwarder · 微信 ↔ QQ ↔ Telegram 三平台訊息轉發路由服務

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [繁體中文](README.zh-TW.md)

[![CI](https://github.com/DaiYiqq/im-forwarder/actions/workflows/ci.yml/badge.svg)](https://github.com/DaiYiqq/im-forwarder/actions/workflows/ci.yml)
[![License: MIT + Commons Clause](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

> ## ⚠️ 禁止用於商業場景、收費服務或付費託管
>
> 本專案**僅供技術研究與個人學習**。
> 微信端接入的是騰訊官方 iLink（ClawBot）開放能力，其授權限於**非商業目的**；
> [LICENSE](LICENSE) 採用 MIT + Commons Clause，明確禁止**出售、付費託管、轉賣**。
> 任何收費轉發、付費託管、作為商業產品的一部分提供，均**不在授權範圍內**。
>
> 若需要商業化的跨平台訊息同步，請向各平台申請官方企業級方案，不要使用本專案。

---

## 一、風險提示（請在安裝前逐條讀完）

1. **僅供技術研究學習，禁止商業用途。** 見 [LICENSE](LICENSE)（MIT + Commons Clause，禁止收費、付費託管、轉賣）。
2. **微信端只能走官方 iLink（ClawBot）通道**，接入網域為 `ilinkai.weixin.qq.com`（由 EasyBot 閘道端完成官方授權）。
   本專案**不含任何**微信登入、掃碼、Cookie、Web 協定、iPad 協定、Hook、逆向工程程式碼。
   微信端**僅處理私聊訊息**：群組訊息既不接收也不傳送；不呼叫好友目錄、訊息收回、歷史查詢等未開放能力。
   iLink 授予的是**非商業目的**授權 —— 將本專案用於任何收費情境都會同時違反該項授權。
3. **QQ 端使用 NapCat + OneBot 11，不是 QQ 官方機器人通道。**
   透過 NapCat 登入個人 QQ 帳號存在**登入驗證、頻繁斷線、封號**等風險。
   **必須使用專用的備用小號**，嚴禁使用主力帳號；由此產生的一切後果由使用者自行承擔。
4. **Telegram 端只能使用官方 Bot API**（透過 BotFather 建立機器人）。
   本專案**嚴禁**使用 MTProto userbot、Telethon、Pyrogram 等以**個人帳號身分**登入的方案，
   原始碼中不存在任何此類程式路徑。Telegram 機器人只能接收使用者主動傳給它的訊息、
   或它所在群組中經授權的訊息；本專案不嘗試讀取任何使用者私聊歷史或他人對話。
5. **資料出境（重點）**：Telegram 伺服器位於**境外**。從微信/QQ 轉發訊息到 Telegram，
   **可能構成《個人資訊保護法》第 38 條所稱的「向境外提供個人資訊」**。因此：
   - 轉發到 Telegram 的功能預設**關閉**，必須在設定中明確開啟；
   - 開啟時必須確認「**僅轉發本人自己的訊息，不轉發他人聊天內容**」；
   - 第 38 條／第 39 條的對應關係見 [COMPLIANCE.md](COMPLIANCE.md)（中文）。
6. **境內網路存取合規**：Telegram 在中國大陸的存取受相關法律法規約束。
   使用者應自行確保網路連線方式合法合規。**本專案不提供、也不建議任何規避性網路方案**，
   儲存庫中不存在代理、隧道、混淆等相關程式碼或設定。
7. **免責**：作者不對使用者的帳號安全（封號、凍結、驗證失敗）、資料外洩、
   第三方濫用、以及任何違反所在地法律法規的行為承擔責任。
   本專案按 [LICENSE](LICENSE)「按現狀」提供，不附帶任何明示或默示擔保。

> 本專案不是法律意見。涉及個人資訊處理的合規判斷，請諮詢專業律師。

---

## 二、它做什麼 / 不做什麼

| | 本專案 | 說明 |
|---|---|---|
| 協定層 | ❌ 不做 | 微信 iLink / NapCat / Telegram Bot API 的連線全部由 **EasyBot 閘道**完成 |
| 轉發路由 | ✅ 做 | `源平台:源對話 → 目標平台:目標對話` 的路由矩陣，支援任意兩平台 |
| 訊息類型 | 僅文字 | 其它類型**明確回執 + 略過**，不靜默丟棄、不自行下載/解析媒體 |
| 微信群組 | ❌ 不做 | 編譯期 + 執行期雙重拒絕，且**沒有**任何設定開關可以放行 |
| 訊息持久化 | ❌ 不做 | 無資料庫、無佇列落盤、無磁碟快取；內文只在記憶體中完成轉換與轉發 |
| 內文日誌 | ❌ 不做 | 日誌欄位白名單，物理上沒有「內文」欄位（見 `src/observability/logger.ts`） |
| 他人內容轉發 | 預設關閉 | 需開啟「告知—同意」機制，未取得同意不轉發 |
| Telegram 出境 | 預設關閉 | 需四項確認齊備；缺少任一項 → **行程拒絕啟動** |

### 資料流

```
   微信私聊(iLink官方) ──▶┌──────────────────────────────────────┐
   QQ 私聊(NapCat)    ──▶│   EasyBot 統一 IM 閘道               │
   Telegram(Bot API)  ──▶│   · 各平台 PlatformAdapter           │
                         │   · 統一 REST(傳送) + WebSocket(事件)│
                         └───────────────┬──────────────────────┘
                                         │  統一事件 / 統一傳送請求
                                         ▼
                         ┌──────────────────────────────────────┐
                         │   im-forwarder（本專案）             │
                         │   合規前置檢查 → 路由矩陣 → 策略鏈   │
                         │   → 文字轉換 → 傳送 → 白名單日誌     │
                         └──────────────────────────────────────┘
```

**本服務不持有任何平台憑證**，只持有一個 EasyBot 閘道的存取權杖（從環境變數讀取）。

---

## 三、快速開始

### 前置條件

- Node.js ≥ 20（開發驗證使用 Node 24）
- 已部署好的 **EasyBot 閘道**，並且已在其內部完成：
  - 微信：官方 iLink（ClawBot）通道授權（掃碼授權由閘道與騰訊官方完成）
  - QQ：NapCat 登入（**請使用專用備用小號**）
  - Telegram（選用）：以 BotFather 建立機器人並填入閘道
- 本儲存庫不負責上述任何一步，也不會替你完成。

### 安裝

```powershell
git clone https://github.com/DaiYiqq/im-forwarder.git
cd im-forwarder
npm install
Copy-Item config/config.example.yaml config/config.yaml
# 注意：本專案**不載入 .env 檔案**（沒有 dotenv 相依套件），權杖必須透過真實環境變數注入。
```

### 設定權杖（只從環境變數讀取，禁止寫進設定檔）

```powershell
$env:EASYBOT_TOKEN = "<你的 EasyBot 閘道權杖>"
```

### 啟動前自檢（建議每次啟動都執行）

```powershell
npx tsx src/main.ts --config config/config.yaml --self-check
# 結束碼 0 = 設定與合規檢查通過；78 = 未通過（會逐條印出原因與修改建議）
```

### 執行

```powershell
npm start
```

### 本機無平台整合測試（mock 閘道，不接觸任何真實帳號）

```powershell
npm run mock                   # 終端機 A：啟動模擬閘道
# 終端機 B：把 config.yaml 的 baseUrl/eventsUrl 指向 mock 印出的位址後再 npm start
```

---

## 四、路由矩陣

設定項採用 `源平台:源對話ID → 目標平台:目標對話ID` 的對照表，**不是兩兩硬編碼**：

```yaml
routes:
  - id: wx-private-to-qq          # 微信私聊 → QQ 指定對話
    group: self-wx-qq             # 同一邏輯鏈路；迴路防護按 group 判定
    contentOwner: self            # 必填：self | third-party（無預設值）
    from: { platform: wechat, conversationId: "wxid_xxx", chatType: private }
    to:
      - { platform: qq, conversationId: "10001", chatType: private }

  - id: qq-to-wx-private          # 反向邊
    group: self-wx-qq
    contentOwner: self
    from: { platform: qq, conversationId: "10001", chatType: private }
    to: { platform: wechat, conversationId: "wxid_xxx", chatType: private }
```

編譯期規則（不滿足即**拒絕啟動**，不做自動取捨）：`chatType` 只能 `private`（所有平台）；
`from`/`to` 不得相同；同一 group 的 `contentOwner` 必須一致；重複 id/邊失敗；
有環必須開啟 `loopGuard`，且環不得跨 group。

迴路防護三層：**回傳 messageId → 短期內容指紋（HMAC，僅記憶體）→ hop 預算**（預設 `maxHops: 1`）。
詳見 [docs/ROUTING.md](docs/ROUTING.md)（中文）。

---

## 五、合規開關（預設全關，缺少即拒絕啟動）

### 資料出境（PIPL 第 38/39 條）

```yaml
compliance:
  telegramCrossBorder:
    enabled: true
    operator: "你的署名"                        # 誰開啟的，要能追溯
    acknowledgedAt: "2026-10-18T12:00:00+08:00" # ISO8601
    selfMessagesOnlyConfirmed: true             # 僅轉發本人訊息
    riskNoticeVersion: "2026-10-18.v1"          # 文案版本變更後需重新確認
```

任一缺少 / 版本不符 → `CROSS_BORDER_GATE_CLOSED` 或 `CROSS_BORDER_ACK_INCOMPLETE` → **結束碼 78**。

### 他人的聊天內容（PIPL 第 23 條）

預設**沒有任何** third-party 路由。若需轉發他人內容：開啟 `thirdPartyConsent.enabled`，
並為每個目標補齊告知要素（`receiver.*`）；對方首則訊息**不轉發**，先送出告知，
對方回覆「同意轉發」後才開始轉發；出境鏈路需要**兩次獨立同意**。
詳見 [docs/CONSENT-FLOW.md](docs/CONSENT-FLOW.md)（中文）與 [COMPLIANCE.md](COMPLIANCE.md)（中文）。

---

## 六、日誌與隱私

```json
{"ts":"2026-10-18T12:34:56.789Z","level":"info","event":"forward","status":"forwarded","routeId":"wx-private-to-qq","sourcePlatform":"wechat","targetPlatform":"qq","latencyMs":42}
```

- 只有白名單欄位（`ts/level/event/routeId/sourcePlatform/targetPlatform/status/errorCode/...`）；
- **沒有**訊息內文、沒有對話 ID、沒有暱稱；
- 超長字串欄位會被替換為 `[omitted:N]`，防止把內文塞進「合法欄位」；
- 該性質由 `test/redaction.spec.ts` 以 canary 字串斷言，不是口頭承諾。

---

## 七、已知限制（不粉飾）

1. **閘道契約需核對**：欄位差異透過 `gateway.fieldMap` 與 `gateway.send.path` 覆蓋，
   **不要**為此引入任何平台 SDK。見 [docs/GATEWAY-CONTRACT.md](docs/GATEWAY-CONTRACT.md)（中文）。
2. **只支援文字**：媒體一律明確略過；本專案不做任何媒體解析。
3. **不支援群組聊天**（任何平台；群組內無法逐成員取得同意）。
4. **同意機制的能力邊界**：只能證明「該私聊對話的回覆方聲稱同意」，無法驗證身分；
   已轉發出去的訊息無法追回。
5. **記憶體擦除無法保證**：JS 執行環境不提供可控的記憶體清零；本專案的邊界是「不落盤、不入日誌、不入佇列」。
6. **NapCat 斷線/封號不可避免**：非官方通道的固有風險，本專案不做任何規避。
7. **`contentOwner` 是自述欄位**：把他人對話標成 `self` 即可繞過同意機制，程式無法判斷對話歸屬。
8. **同意記錄沒有簽章**：`data/consent.json` 是本機 JSON，可被偽造，只具內部可信度。
9. **信任邊界在閘道**：`chatType`、`senderIsSelf`、`senderIsBot` 均來自閘道回報；
   閘道端自身的合規性是本專案最大的未知項，不在本儲存庫可控範圍內。

---

## 八、品質把關

```powershell
npm run check        # typecheck + 靜態合規掃描 + 全量測試（63 個案例）
npm run typecheck
npm run compliance:scan
npm test
```

CI 見 [.github/workflows/ci.yml](.github/workflows/ci.yml)；獨立稽核報告見
[docs/AUDIT.md](docs/AUDIT.md)（中文；8 條驗收、黑箱結束碼、PoC、改善紀錄）。

---

## 九、開發者聯絡方式

| 管道 | 資訊 |
|---|---|
| 開發者 | **戴億（DaiYi）** |
| GitHub | [@DaiYiqq](https://github.com/DaiYiqq) |
| QQ 信箱 | **1703205607@qq.com** |
| Gmail | **daiy91004@gmail.com** |
| QQ | **1703205607** |
| 微信 | **daiyi091004** |
| 抖音 | **daiyi091004** |
| Issue（建議回報 Bug） | [github.com/DaiYiqq/im-forwarder/issues](https://github.com/DaiYiqq/im-forwarder/issues) |

- **安全漏洞或濫用檢舉**請先看 [SECURITY.md](SECURITY.md)，不要在公開 Issue 裡貼憑證、聊天內容或個人資訊。
- 請勿透過任何管道傳送敏感個人資訊。
- 完整聯絡方式與溝通約定見 [CONTACT.md](CONTACT.md)。

---

## 十、社群共同維護

本專案**由社群共同維護**，但有一條不可退讓的紅線：**合規不變量不得被削弱**。

- **貢獻指南**：[CONTRIBUTING.md](CONTRIBUTING.md) —— 流程、程式碼風格、必跑檢查，
  以及 PR 不得破壞的合規不變量清單。
- **治理規則**：[GOVERNANCE.md](GOVERNANCE.md) —— 角色、審查規則、發布流程。
- **翻譯**：[TRANSLATIONS.md](TRANSLATIONS.md) —— 以英文版 [README.en.md](README.en.md) 為基準版本，
  其餘語言（包含本繁體中文版）由社群盡力維護。
- **行為準則**：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- **合規討論**：使用 *compliance concern* 類 Issue 範本。
- **新手任務**：標籤 `good first issue`；文件與翻譯修正永遠歡迎。

誰能合併什麼、需要幾位審查者：見 [GOVERNANCE.md](GOVERNANCE.md)。任何觸及
`src/compliance/**`、`src/config/schema.ts`、`LICENSE`、`COMPLIANCE.md` 的 PR，
都需要第二位審查者，並且 `npm run check` 必須全綠。

---

## 十一、授權條款

MIT **+ Commons Clause**：允許使用、複製、修改、合併、發布、散布、再授權；
**禁止出售、付費託管、轉賣**。完整條文見 [LICENSE](LICENSE)。
此組合**不是** OSI 認可的開源授權，請勿當作開源專案使用。

本專案與騰訊、QQ、Telegram 無隸屬關係；相關商標歸各自權利人所有。
