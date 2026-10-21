/**
 * 截图/录屏专用 preload：只提供 window.desktop 的**假数据实现**。
 *
 * 用途：在 CI 或本地无网关环境下，用真实渲染进程界面生成 README/Demo 配图。
 * 边界：
 *  · 不连接任何平台、不读取真实配置、不接触令牌；
 *  · 所有数据为固定的演示数据，界面里没有任何真实聊天内容（本来也没有）。
 */
const { contextBridge } = require("electron");

const NOW = Date.now();
const fixed = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

const status = {
  running: true,
  startedAt: NOW - 2 * 3600 * 1000,
  routeCount: 2,
  gateway: { baseUrlHost: "127.0.0.1:18080" },
  crossBorderOpen: false,
  counts: { forwarded: 128, failed: 0, skipped: 3 },
};

const companion = {
  running: true,
  host: "127.0.0.1",
  port: 17871,
  lanMode: false,
  address: "http://127.0.0.1:17871",
  pairCode: "482913",
  pairCodeExpiresAt: NOW + 9 * 60 * 1000,
  tokenExpiresAt: null,
  staticAvailable: true,
  credentialsPersistent: true,
  warning: null,
  error: null,
};

const tokenStatus = {
  saved: true,
  source: "safeStorage",
  encryptionAvailable: true,
  tokenEnv: "EASYBOT_TOKEN",
};

const appInfo = {
  name: "im-forwarder",
  version: "0.2.0",
  electronVersion: "44.9.1",
  nodeVersion: "24.21.0",
  chromeVersion: "144.0.0.0",
  platform: "win32",
  configPath: "C:\\Users\\demo\\AppData\\Roaming\\im-forwarder\\config.yaml",
  homepage: "https://github.com/DaiYiqq/im-forwarder",
  issuesUrl: "https://github.com/DaiYiqq/im-forwarder/issues",
  license: "MIT + Commons Clause（非商业）",
  signed: false,
  autoUpdate: false,
};

const configContent = `# im-forwarder 配置（演示数据；此处不含任何令牌）
version: 1

gateway:
  baseUrl: "http://127.0.0.1:18080"
  eventsUrl: "ws://127.0.0.1:18080/ws/events"
  tokenEnv: "EASYBOT_TOKEN"
  requestTimeoutMs: 10000
  maxRetries: 2

compliance:
  telegramCrossBorder:
    enabled: false
    operator: null
    acknowledgedAt: null
    selfMessagesOnlyConfirmed: false
    riskNoticeVersion: "2026-10-18.v1"
  thirdPartyConsent:
    enabled: false
    persist: true
    allowCrossBorder: false
  unsupportedMedia:
    replyNotice: true
  loopGuard:
    enabled: true
    echoTtlMs: 300000
    fingerprintWindowMs: 20000
    maxHops: 1
  logLevel: "info"

routes:
  - id: wx-private-to-qq
    group: self-wx-qq
    contentOwner: self
    from:
      platform: wechat
      conversationId: "wxid_demo_account"
      chatType: private
    to:
      - platform: qq
        conversationId: "10001"
        chatType: private
  - id: qq-to-wx-private
    group: self-wx-qq
    contentOwner: self
    from:
      platform: qq
      conversationId: "10001"
      chatType: private
    to:
      - platform: wechat
        conversationId: "wxid_demo_account"
        chatType: private
`;

const logs = [
  { ts: fixed(8), level: "info", event: "forward", routeId: "wx-private-to-qq", sourcePlatform: "wechat", targetPlatform: "qq", status: "forwarded", latencyMs: 41 },
  { ts: fixed(27), level: "info", event: "forward", routeId: "qq-to-wx-private", sourcePlatform: "qq", targetPlatform: "wechat", status: "forwarded", latencyMs: 58 },
  { ts: fixed(64), level: "warn", event: "forward", sourcePlatform: "wechat", status: "skipped_unsupported_kind", errorCode: "unsupported_kind" },
  { ts: fixed(93), level: "info", event: "forward", routeId: "wx-private-to-qq", sourcePlatform: "wechat", targetPlatform: "qq", status: "forwarded", latencyMs: 37 },
  { ts: fixed(140), level: "warn", event: "forward", sourcePlatform: "wechat", status: "skipped_group_forbidden" },
  { ts: fixed(188), level: "info", event: "consent", status: "blocked_consent_pending", routeId: "colleague-wx-to-qq", sourcePlatform: "wechat" },
  { ts: fixed(240), level: "info", event: "notice", status: "notice_sent", sourcePlatform: "wechat" },
  { ts: fixed(310), level: "info", event: "forward", routeId: "wx-private-to-qq", sourcePlatform: "wechat", targetPlatform: "qq", status: "forwarded", latencyMs: 52 },
];

const noopSubscribe = () => () => {};

contextBridge.exposeInMainWorld("desktop", {
  getStatus: async () => status,
  getConfig: async () => ({
    path: appInfo.configPath,
    content: configContent,
    exists: true,
    exampleAvailable: true,
  }),
  getExampleConfig: async () => configContent,
  validateConfig: async () => ({ ok: true, violations: [] }),
  saveConfig: async () => ({ ok: true, saved: true, violations: [], routeCount: 2 }),
  getTokenStatus: async () => tokenStatus,
  setToken: async () => tokenStatus,
  clearToken: async () => ({ ...tokenStatus, saved: false, source: "none" }),
  start: async () => ({ ok: true, running: true }),
  stop: async () => ({ ok: true, running: false }),
  getCompanionState: async () => companion,
  setLanMode: async () => companion,
  setCompanionPort: async () => companion,
  newPairCode: async () => ({ ...companion, pairCode: "731204" }),
  getLogs: async () => logs,
  getAppInfo: async () => appInfo,
  openExternal: async () => true,
  onStatus: noopSubscribe,
  onLog: noopSubscribe,
  onCompanion: noopSubscribe,
});
