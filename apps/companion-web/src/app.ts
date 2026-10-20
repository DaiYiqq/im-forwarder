/**
 * 移动伴生控制端 UI 与路由（原生 DOM，无框架）。
 *
 * 视图：连接 / 状态 / 路由 / 日志 / 实验模式 / 关于，用 `#/xxx` 哈希路由。
 *
 * 合规相关的 UI 约束（本文件是最后一道展示防线）：
 *  - 只展示桌面 API 的白名单字段与 B 模式的元数据日志，绝不渲染消息正文；
 *  - 令牌输入框只在"配对/启动实验模式"时读取一次：
 *    A 模式令牌交给内存 `CompanionStore`，B 模式令牌交给 `GatewayClient` 后立即清空输入框；
 *  - 启动实验模式前必须勾选风险确认，并且页面切后台/锁屏时立即停止。
 */

import {
  CompanionApi,
  CompanionApiError,
  LOG_FIELD_WHITELIST,
  platformLabel,
  type HealthInfo,
  type LogRow,
  type RouteView,
  type StatusInfo,
} from "./api.ts";
import { CompanionStore, normalizeHost } from "./store.ts";
import {
  B_MODE_STATUS_LABELS,
  BModeRunner,
  type RunnerView,
  type VisibilityPort,
} from "./experimental/runner.ts";
import { GatewayClient } from "./experimental/gateway.ts";
import { parseBModeRoutes } from "./experimental/routing.ts";

const APP_VERSION = "0.2.0";
const POLL_INTERVAL_MS = 3000;

type ViewId = "connect" | "status" | "routes" | "logs" | "experimental" | "about";

interface NavItem {
  id: ViewId;
  label: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: "connect", label: "连接" },
  { id: "status", label: "状态" },
  { id: "routes", label: "路由" },
  { id: "logs", label: "日志" },
  { id: "experimental", label: "实验模式" },
  { id: "about", label: "关于" },
];

const VIEW_TITLES: Record<ViewId, string> = {
  connect: "连接桌面端",
  status: "转发状态",
  routes: "路由（已脱敏）",
  logs: "日志（白名单字段）",
  experimental: "实验模式：本机前台转发",
  about: "关于与合规说明",
};

interface Notice {
  kind: "error" | "success" | "info";
  text: string;
  details: string[];
}

type ChildLike = Node | string | null | undefined;

const store = new CompanionStore();
let api: CompanionApi | null = null;
let runner: BModeRunner | null = null;
let runnerView: RunnerView | null = null;
let pollTimer: number | null = null;
let renderToken = 0;
let currentView: ViewId = "connect";
let notice: Notice | null = null;
let runnerSection: HTMLElement | null = null;

/** B 模式表单的会话内缓存（仅内存；不含令牌）。 */
const bForm = {
  wsUrl: "",
  restUrl: "",
  routesJson: "",
  acknowledged: false,
};

const DEFAULT_ROUTES_JSON = JSON.stringify(
  [
    {
      id: "wx-to-qq",
      group: "self-pair",
      contentOwner: "self",
      from: { platform: "wechat", conversationId: "替换为你的微信私聊会话ID", chatType: "private" },
      to: [{ platform: "qq", conversationId: "替换为你的 QQ 私聊会话ID", chatType: "private" }],
    },
    {
      id: "qq-to-wx",
      group: "self-pair",
      contentOwner: "self",
      from: { platform: "qq", conversationId: "替换为你的 QQ 私聊会话ID", chatType: "private" },
      to: [{ platform: "wechat", conversationId: "替换为你的微信私聊会话ID", chatType: "private" }],
    },
  ],
  null,
  2,
);

// ─────────────────────────────── DOM 辅助 ───────────────────────────────

interface ElementInit {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  onClick?: () => void;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  init: ElementInit = {},
  children: readonly ChildLike[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (init.class !== undefined) node.className = init.class;
  if (init.text !== undefined) node.textContent = init.text;
  if (init.attrs !== undefined) {
    for (const [key, value] of Object.entries(init.attrs)) node.setAttribute(key, value);
  }
  if (init.onClick !== undefined) node.addEventListener("click", init.onClick);
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function card(label: string, value: ChildLike, hint?: string): HTMLElement {
  const children: ChildLike[] = [h("div", { class: "card-label", text: label }), h("div", { class: "card-value" }, [value])];
  if (hint !== undefined) children.push(h("div", { class: "card-hint", text: hint }));
  return h("div", { class: "card" }, children);
}

function badge(text: string, tone: "ok" | "warn" | "muted" | "danger"): HTMLElement {
  return h("span", { class: `badge badge-${tone}`, text });
}

function noticeBlock(value: Notice): HTMLElement {
  const children: ChildLike[] = [h("div", { class: "notice-text", text: value.text })];
  if (value.details.length > 0) {
    children.push(
      h(
        "ul",
        { class: "notice-list" },
        value.details.map((detail) => h("li", { text: detail })),
      ),
    );
  }
  return h("div", { class: `notice notice-${value.kind}`, attrs: { role: "status" } }, children);
}

function sectionTitle(text: string): HTMLElement {
  return h("h2", { class: "section-title", text });
}

function hint(text: string): HTMLElement {
  return h("p", { class: "hint", text });
}

function table(headers: readonly string[], rows: readonly (readonly ChildLike[])[]): HTMLElement {
  return h("div", { class: "table-wrap" }, [
    h("table", {}, [
      h(
        "thead",
        {},
        [h("tr", {}, headers.map((header) => h("th", { text: header })))],
      ),
      h(
        "tbody",
        {},
        rows.map((row) => h("tr", {}, row.map((cell) => h("td", {}, [cell])))),
      ),
    ]),
  ]);
}

function formatTs(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
  }
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
  }
  return "—";
}

function errorDetails(error: unknown): Notice {
  if (error instanceof CompanionApiError) {
    return { kind: "error", text: error.message, details: error.violations };
  }
  if (error instanceof Error) {
    return { kind: "error", text: error.message, details: [] };
  }
  return { kind: "error", text: "发生未知错误，请重试。", details: [] };
}

function setNotice(next: Notice | null): void {
  notice = next;
}

// ─────────────────────────────── 路由与外壳 ───────────────────────────────

function viewFromHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/u, "");
  const found = NAV_ITEMS.find((item) => item.id === raw);
  return found === undefined ? "connect" : found.id;
}

function updateHeader(): void {
  const chip = document.getElementById("connection-chip");
  if (chip === null) return;
  chip.replaceChildren();
  if (store.paired) {
    chip.append(badge("已配对（令牌仅在内存）", "ok"));
  } else {
    chip.append(badge("未配对", "warn"));
  }
}

function navigate(view: ViewId): void {
  const next = `#/${view}`;
  if (window.location.hash === next) {
    void render();
    return;
  }
  window.location.hash = next;
}

function clearPoll(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function startPoll(task: () => Promise<void>): void {
  clearPoll();
  const tick = (): void => {
    void (async () => {
      if (document.visibilityState === "visible") {
        try {
          await task();
        } catch {
          // 轮询失败不打断界面：具体错误由单次操作展示。
        }
      }
      pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
    })();
  };
  pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
}

function requireApi(container: HTMLElement, token: number): CompanionApi | null {
  if (store.host === "" || store.token === null) {
    container.append(
      h("div", { class: "empty-state" }, [
        hint("尚未连接桌面端。请先在「连接」页输入桌面端地址与 6 位配对码。"),
        h("button", {
          class: "btn btn-primary",
          text: "去连接",
          onClick: () => navigate("connect"),
        }),
      ]),
    );
    return null;
  }
  if (api === null) {
    api = new CompanionApi(store.host, store.token);
  }
  if (token !== renderToken) return null;
  return api;
}

function handleApiFailure(container: HTMLElement, error: unknown): void {
  const details = errorDetails(error);
  container.append(noticeBlock(details));
  if (error instanceof CompanionApiError && error.kind === "unauthorized") {
    store.clearToken();
    api = null;
    updateHeader();
    container.append(
      h("button", {
        class: "btn btn-primary",
        text: "重新配对",
        onClick: () => navigate("connect"),
      }),
    );
  }
}

async function render(): Promise<void> {
  const token = ++renderToken;
  clearPoll();
  const view = viewFromHash();
  currentView = view;
  runnerSection = null;

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-nav]")) {
    const active = button.dataset["nav"] === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  const main = document.getElementById("view");
  if (main === null) return;
  const title = document.getElementById("view-title");
  if (title !== null) title.textContent = VIEW_TITLES[view];
  main.replaceChildren();
  if (notice !== null) main.append(noticeBlock(notice));

  switch (view) {
    case "connect":
      renderConnect(main);
      break;
    case "status":
      await renderStatus(main, token);
      break;
    case "routes":
      await renderRoutes(main, token);
      break;
    case "logs":
      await renderLogs(main, token);
      break;
    case "experimental":
      renderExperimental(main);
      break;
    case "about":
      renderAbout(main);
      break;
  }
  updateHeader();
}

// ─────────────────────────────── 连接页 ───────────────────────────────

function renderConnect(main: HTMLElement): void {
  const hostField = h("input", {
    class: "field",
    attrs: {
      id: "host-input",
      type: "text",
      inputmode: "url",
      placeholder: "http://192.168.1.8:3210",
      value: store.host,
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const codeField = h("input", {
    class: "field",
    attrs: {
      id: "code-input",
      type: "text",
      inputmode: "numeric",
      maxlength: "6",
      placeholder: "6 位配对码",
      autocomplete: "one-time-code",
    },
  });

  const statusLine = h("p", { class: "hint" });
  if (store.paired) {
    statusLine.textContent = "已配对：令牌只保存在内存中，刷新页面或重启应用后需要重新配对。";
  } else {
    statusLine.textContent = "未配对。";
  }

  const pairButton = h("button", {
    class: "btn btn-primary",
    text: "配对并连接",
    onClick: () => {
      void handlePair(hostField.value, codeField.value);
    },
  });

  const probeButton = h("button", {
    class: "btn",
    text: "仅探测连通性",
    onClick: () => {
      void handleProbe(hostField.value);
    },
  });

  const disconnectButton = h("button", {
    class: "btn btn-danger",
    text: "断开并清除令牌",
    onClick: () => {
      store.clearToken();
      api = null;
      setNotice({ kind: "success", text: "已清除内存令牌。", details: [] });
      void render();
    },
  });

  main.append(
    h("div", { class: "panel" }, [
      hint(
        "手机与电脑必须在同一局域网。桌面端需开启「局域网访问 / 伴生服务」，并放行防火墙端口。" +
          "配对码在桌面端「移动端配对」里生成，6 位数字，通常几分钟内有效。",
      ),
      h("label", { class: "field-label", attrs: { for: "host-input" }, text: "桌面端伴生服务地址" }),
      hostField,
      h("label", { class: "field-label", attrs: { for: "code-input" }, text: "配对码（6 位数字）" }),
      codeField,
      h("div", { class: "btn-row" }, [pairButton, probeButton]),
      statusLine,
      store.paired ? h("div", { class: "btn-row" }, [disconnectButton]) : h("span"),
      h("div", { class: "divider" }),
      hint(
        "安全说明：配对令牌只存在内存（不上 localStorage、不写 URL、不进日志）。" +
          "本应用只调用桌面端伴生 API，不直接接触微信/QQ/Telegram 凭证。",
      ),
    ]),
  );
}

async function handlePair(hostInput: string, code: string): Promise<void> {
  setNotice(null);
  const normalized = normalizeHost(hostInput);
  if ("error" in normalized) {
    setNotice({ kind: "error", text: normalized.error, details: [] });
    void render();
    return;
  }
  try {
    const unauth = new CompanionApi(normalized.host, "");
    const paired = await unauth.pair(code);
    store.setHost(normalized.host);
    store.setToken(paired.token, paired.expiresAt);
    api = new CompanionApi(normalized.host, paired.token);
    setNotice({
      kind: "success",
      text:
        paired.expiresAt === null
          ? "配对成功。令牌只在内存中，刷新后需重新配对。"
          : `配对成功，令牌有效期至 ${formatTs(paired.expiresAt)}（只存在内存中）。`,
      details: [],
    });
    navigate("status");
  } catch (error) {
    setNotice(errorDetails(error));
    void render();
  }
}

async function handleProbe(hostInput: string): Promise<void> {
  setNotice(null);
  const normalized = normalizeHost(hostInput);
  if ("error" in normalized) {
    setNotice({ kind: "error", text: normalized.error, details: [] });
    void render();
    return;
  }
  try {
    const health = await new CompanionApi(normalized.host, "").health();
    setNotice({
      kind: "success",
      text: `连通正常：${health.app} ${health.version}（${health.ok ? "健康" : "异常"}）。`,
      details: [],
    });
  } catch (error) {
    setNotice(errorDetails(error));
  }
  void render();
}

// ─────────────────────────────── 状态页 ───────────────────────────────

async function renderStatus(main: HTMLElement, token: number): Promise<void> {
  const client = requireApi(main, token);
  if (client === null) return;

  const panel = h("div", { class: "status-panel" }, [h("p", { class: "hint", text: "正在读取桌面端状态…" })]);
  main.append(panel);

  const refresh = async (): Promise<void> => {
    const [health, status] = await Promise.all([client.health(), client.status()]);
    if (token !== renderToken) return;
    renderStatusPanel(panel, health, status, token);
  };

  try {
    await refresh();
    startPoll(async () => {
      if (token !== renderToken) return;
      await refresh();
    });
  } catch (error) {
    if (token !== renderToken) return;
    panel.replaceChildren();
    handleApiFailure(panel, error);
  }
}

function renderStatusPanel(panel: HTMLElement, health: HealthInfo, status: StatusInfo, token: number): void {
  const runningBadge = status.running ? badge("运行中", "ok") : badge("已停止", "muted");
  const counts = status.counts;

  panel.replaceChildren(
    h("div", { class: "card-grid" }, [
      card("运行状态", runningBadge, status.startedAt === null ? undefined : `启动于 ${formatTs(status.startedAt)}`),
      card("路由数", String(status.routeCount), "桌面端已编译的路由条数"),
      card("网关主机", status.gatewayHost, "桌面端连接的外部网关"),
      card(
        "出境开关",
        status.crossBorderOpen ? badge("已开启", "warn") : badge("关闭", "muted"),
        "跨境的 Telegram 链路默认关闭",
      ),
      card("已转发", String(counts.forwarded)),
      card("失败", String(counts.failed)),
      card("已跳过", String(counts.skipped)),
      card("桌面端版本", `${health.app} ${health.version}`),
    ]),
  );

  const startButton = h("button", {
    class: "btn btn-primary",
    text: "启动转发",
    onClick: () => {
      void controlAction("start", panel, token);
    },
  });
  startButton.disabled = status.running;

  const stopButton = h("button", {
    class: "btn btn-danger",
    text: "停止转发",
    onClick: () => {
      void controlAction("stop", panel, token);
    },
  });
  stopButton.disabled = !status.running;

  panel.append(
    h("div", { class: "btn-row" }, [startButton, stopButton]),
    hint(
      "启动前的合规预检由桌面端执行：任何一条不合规都会被拒绝（409），并逐条列出原因。" +
        "本页只负责发起控制，不绕过桌面端策略。",
    ),
  );
}

async function controlAction(action: "start" | "stop", panel: HTMLElement, token: number): Promise<void> {
  const client = api;
  if (client === null) return;
  try {
    const result = await client.control(action);
    setNotice({
      kind: "success",
      text: action === "start" ? "已请求启动转发。" : "已请求停止转发。",
      details: [],
    });
    if (token === renderToken) {
      const status = await client.status();
      const health = await client.health();
      if (token === renderToken) renderStatusPanel(panel, health, { ...status, running: result.running }, token);
    }
  } catch (error) {
    setNotice(errorDetails(error));
    if (token === renderToken) {
      panel.replaceChildren(noticeBlock(errorDetails(error)));
      handleApiFailure(panel, error);
    }
  }
}

// ─────────────────────────────── 路由页 ───────────────────────────────

async function renderRoutes(main: HTMLElement, token: number): Promise<void> {
  const client = requireApi(main, token);
  if (client === null) return;

  const holder = h("div", { class: "panel" }, [h("p", { class: "hint", text: "正在读取路由…" })]);
  main.append(holder);

  const paint = (routes: readonly RouteView[]): void => {
    holder.replaceChildren(
      hint("以下为桌面端脱敏后的路由：不含会话 ID / 接收方信息，本应用也不会请求这些字段。"),
      routes.length === 0
        ? h("p", { class: "hint", text: "桌面端没有已编译的路由。" })
        : table(
            ["ID", "分组", "内容归属", "从", "到"],
            routes.map((route) => [
              route.id,
              route.group,
              route.contentOwner === "self" ? "本人" : route.contentOwner,
              route.from,
              route.to.join(" ／ "),
            ]),
          ),
    );
  };

  try {
    paint(await client.routes());
    startPoll(async () => {
      if (token !== renderToken) return;
      paint(await client.routes());
    });
  } catch (error) {
    if (token !== renderToken) return;
    holder.replaceChildren();
    handleApiFailure(holder, error);
  }
}

// ─────────────────────────────── 日志页 ───────────────────────────────

const LOG_COLUMNS: readonly string[] = ["时间", "级别", "事件", "路由", "来源 → 目标", "状态", "错误码", "耗时(ms)"];

function logRowToCells(row: LogRow): ChildLike[] {
  const source = typeof row.sourcePlatform === "string" ? platformLabel(row.sourcePlatform) : "—";
  const target = typeof row.targetPlatform === "string" ? platformLabel(row.targetPlatform) : "—";
  return [
    formatTs(row.ts),
    typeof row.level === "string" ? row.level : "—",
    typeof row.event === "string" ? row.event : "—",
    typeof row.routeId === "string" ? row.routeId : "—",
    `${source} → ${target}`,
    typeof row.status === "string" ? row.status : "—",
    typeof row.errorCode === "string" ? row.errorCode : "—",
    typeof row.latencyMs === "number" ? String(row.latencyMs) : "—",
  ];
}

async function renderLogs(main: HTMLElement, token: number): Promise<void> {
  const client = requireApi(main, token);
  if (client === null) return;

  const holder = h("div", { class: "panel" }, [h("p", { class: "hint", text: "正在读取日志…" })]);
  main.append(holder);

  const paint = (rows: readonly LogRow[]): void => {
    holder.replaceChildren(
      hint(
        "日志只显示桌面端白名单字段（" +
          LOG_FIELD_WHITELIST.slice(0, 8).join(" / ") +
          " 等），不含任何消息正文。最多 100 条，每 3 秒刷新。",
      ),
      rows.length === 0
        ? h("p", { class: "hint", text: "暂无日志。" })
        : table(LOG_COLUMNS, rows.map(logRowToCells)),
    );
  };

  const load = async (): Promise<void> => {
    const rows = await client.logs(100);
    if (token !== renderToken) return;
    paint(rows);
  };

  try {
    await load();
    startPoll(async () => {
      if (token !== renderToken) return;
      await load();
    });
  } catch (error) {
    if (token !== renderToken) return;
    holder.replaceChildren();
    handleApiFailure(holder, error);
  }
}

// ─────────────────────────── 实验模式（B） ───────────────────────────

const browserVisibility: VisibilityPort = {
  subscribe(onHidden: () => void): () => void {
    const handler = (): void => {
      if (document.visibilityState === "hidden") onHidden();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
};

function renderExperimental(main: HTMLElement): void {
  main.append(
    h("div", { class: "banner banner-danger", attrs: { role: "alert" } }, [
      h("strong", { text: "实验性功能（默认关闭）" }),
      h("span", {
        text:
          "仅前台运行：锁屏 / 切后台 / 刷新页面会立即停止。仅支持文本、仅私聊、仅本人路由（微信 ↔ QQ）；" +
          "不支持 Telegram、他人内容（third-party）、群聊与任何媒体。",
      }),
    ]),
  );

  if (runner !== null && runner.isRunning) {
    runnerSection = h("div", { class: "panel", attrs: { id: "b-runner" } }, [
      buildRunnerPanel(runnerView ?? runner.view(), true),
    ]);
    main.append(runnerSection);
    return;
  }

  main.append(
    buildExperimentalForm((config) => {
      void startExperimental(config);
    }),
  );

  if (runnerView !== null && runnerView.logs.length > 0) {
    runnerSection = h("div", { class: "panel", attrs: { id: "b-runner" } }, [buildRunnerPanel(runnerView, false)]);
    main.append(runnerSection);
  }
}

interface ExperimentalFormValues {
  wsUrl: string;
  restUrl: string;
  token: string;
  routesJson: string;
}

function buildExperimentalForm(onStart: (values: ExperimentalFormValues) => void): HTMLElement {
  const wsField = h("input", {
    class: "field",
    attrs: {
      type: "text",
      inputmode: "url",
      placeholder: "ws://192.168.1.8:18080/ws/events",
      value: bForm.wsUrl,
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const restField = h("input", {
    class: "field",
    attrs: {
      type: "text",
      inputmode: "url",
      placeholder: "http://192.168.1.8:18080",
      value: bForm.restUrl,
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const tokenField = h("input", {
    class: "field",
    attrs: {
      type: "password",
      placeholder: "网关令牌（仅保存在内存，启动后输入框即清空）",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const routesField = h("textarea", {
    class: "field field-textarea",
    attrs: { rows: "12", spellcheck: "false", placeholder: "路由 JSON 数组" },
  });
  routesField.value = bForm.routesJson.length > 0 ? bForm.routesJson : DEFAULT_ROUTES_JSON;

  const violationsPanel = h("div", { class: "violations" });
  const acknowledged = h("input", { attrs: { type: "checkbox", id: "b-ack" } });
  if (bForm.acknowledged) acknowledged.checked = true;

  const collect = (): ExperimentalFormValues => ({
    wsUrl: wsField.value.trim(),
    restUrl: restField.value.trim(),
    token: tokenField.value,
    routesJson: routesField.value,
  });

  const validateButton = h("button", {
    class: "btn",
    text: "仅校验路由",
    onClick: () => {
      bForm.routesJson = routesField.value;
      const parsed = parseBModeRoutes(routesField.value);
      violationsPanel.replaceChildren();
      if (parsed.violations.length === 0) {
        violationsPanel.append(
          noticeBlock({
            kind: "success",
            text: `路由校验通过（${parsed.routes.length} 条，全部为私聊 + 本人 + 微信↔QQ）。`,
            details: [],
          }),
        );
      } else {
        violationsPanel.append(noticeBlock({ kind: "error", text: "路由校验未通过：", details: parsed.violations }));
      }
    },
  });

  const startButton = h("button", {
    class: "btn btn-primary",
    text: "启动实验转发",
    onClick: () => {
      bForm.acknowledged = acknowledged.checked;
      onStart(collect());
    },
  });

  return h("div", { class: "panel" }, [
    h("label", { class: "field-label", text: "网关 WebSocket 地址" }),
    wsField,
    h("label", { class: "field-label", text: "网关 REST 地址" }),
    restField,
    h("label", { class: "field-label", text: "网关令牌（Bearer，仅内存）" }),
    tokenField,
    h("label", { class: "field-label", text: "路由 JSON（仅允许 private + self + 微信↔QQ）" }),
    routesField,
    hint(
      "浏览器直连的硬限制：WebSocket 无法自定义 Authorization 请求头，也无法把令牌放 URL（红线）。" +
        "因此本模式要求网关支持 CORS，且 WebSocket 接受 `bearer.<base64url(token)>` 子协议鉴权；" +
        "网关不支持时请使用 A 模式（经桌面端转发）。",
    ),
    h("label", { class: "check-row", attrs: { for: "b-ack" } }, [
      acknowledged,
      h("span", {
        text:
          "我确认：只转发本人私聊中的文本消息；不用于群聊、他人内容、媒体或 Telegram；理解切后台即停止。",
      }),
    ]),
    h("div", { class: "btn-row" }, [startButton, validateButton]),
    violationsPanel,
  ]);
}

async function startExperimental(values: ExperimentalFormValues): Promise<void> {
  setNotice(null);

  const parsed = parseBModeRoutes(values.routesJson);
  if (parsed.violations.length > 0) {
    setNotice({ kind: "error", text: "路由校验未通过，已拒绝启动：", details: parsed.violations });
    void render();
    return;
  }
  if (!bForm.acknowledged) {
    setNotice({ kind: "error", text: "请先勾选风险确认，再启动实验模式。", details: [] });
    void render();
    return;
  }
  if (values.wsUrl.length === 0 || values.restUrl.length === 0) {
    setNotice({ kind: "error", text: "请填写网关 WebSocket 与 REST 地址。", details: [] });
    void render();
    return;
  }
  if (values.token.trim().length === 0) {
    setNotice({ kind: "error", text: "请填写网关令牌（只保存在内存）。", details: [] });
    void render();
    return;
  }

  // 表单里的地址与路由只在内存里记录，令牌不记录。
  bForm.wsUrl = values.wsUrl;
  bForm.restUrl = values.restUrl;
  bForm.routesJson = values.routesJson;

  const nextRunner = new BModeRunner({
    routes: parsed.routes,
    visibility: browserVisibility,
    onUpdate: (view) => {
      runnerView = view;
      if (currentView !== "experimental") return;
      if (runnerSection !== null) {
        runnerSection.replaceChildren(buildRunnerPanel(view, view.running));
      }
    },
    createGateway: (callbacks) =>
      new GatewayClient(
        { wsUrl: bForm.wsUrl, restUrl: bForm.restUrl, token: values.token },
        callbacks,
      ),
  });
  runner = nextRunner;
  runnerView = nextRunner.view();

  try {
    await nextRunner.start();
    setNotice({ kind: "success", text: "实验模式已启动。切后台或锁屏会立即停止。", details: [] });
  } catch (error) {
    runner = null;
    runnerView = nextRunner.view();
    setNotice(errorDetails(error));
  }
  void render();
}

function buildRunnerPanel(view: RunnerView, running: boolean): HTMLElement {
  const counters = view.counters;
  const children: ChildLike[] = [
    h("div", { class: "banner banner-warn", attrs: { role: "status" } }, [
      h("strong", { text: "实验性：仅前台运行，锁屏/切后台即停止；不支持 Telegram/他人内容/群聊/媒体。" }),
    ]),
    h("div", { class: "card-grid" }, [
      card("状态", running ? badge("运行中", "ok") : badge("已停止", "muted")),
      card("已转发", String(counters.forwarded)),
      card("失败", String(counters.failed)),
      card("已跳过", String(counters.skipped)),
    ]),
  ];

  if (!running && view.stoppedReason !== null) {
    children.push(
      noticeBlock({ kind: "info", text: `已停止：${view.stoppedReason}`, details: [] }),
    );
  }
  if (view.lastError !== null && running) {
    children.push(noticeBlock({ kind: "info", text: view.lastError, details: [] }));
  }

  children.push(
    h("div", { class: "btn-row" }, [
      h("button", {
        class: "btn btn-danger",
        text: "停止并清除内存令牌",
        onClick: () => {
          void stopExperimental();
        },
      }),
    ]),
  );

  children.push(sectionTitle("最近 20 条元数据日志（不含正文）"));
  if (view.logs.length === 0) {
    children.push(h("p", { class: "hint", text: "暂无日志。" }));
  } else {
    children.push(
      table(
        ["时间", "状态", "路由", "来源 → 目标", "类型", "错误码"],
        view.logs.map((entry) => [
          formatTs(entry.ts),
          B_MODE_STATUS_LABELS[entry.status],
          entry.routeId ?? "—",
          `${entry.sourcePlatform === undefined ? "—" : platformLabel(entry.sourcePlatform)} → ${
            entry.targetPlatform === undefined ? "—" : platformLabel(entry.targetPlatform)
          }`,
          entry.kind ?? "—",
          entry.errorCode ?? (entry.truncated === true ? "已截断" : "—"),
        ]),
      ),
    );
  }

  if (view.notices.length > 0) {
    children.push(sectionTitle("跳过提示"));
    children.push(
      h(
        "ul",
        { class: "notice-list" },
        view.notices.map((item) => h("li", { text: `${formatTs(item.ts)} ${item.text}` })),
      ),
    );
  }

  return h("div", {}, children);
}

async function stopExperimental(): Promise<void> {
  const current = runner;
  if (current === null) return;
  await current.stop("用户手动停止（令牌与指纹表已清空）");
  runner = null;
  runnerView = null;
  setNotice({ kind: "success", text: "实验模式已停止，内存令牌与内容指纹已清空。", details: [] });
  void render();
}

// ─────────────────────────────── 关于页 ───────────────────────────────

function renderAbout(main: HTMLElement): void {
  main.append(
    h("div", { class: "panel" }, [
      sectionTitle("这是什么"),
      hint(
        "im-forwarder 移动伴生控制端：通过桌面端伴生 API 查看转发状态、脱敏路由与白名单日志，并启停转发。" +
          "同一个 Web 应用既是 PWA（可添加到主屏幕），也是 Android APK 的 WebView 内容。",
      ),
      sectionTitle("合规边界（硬性）"),
      h("ul", { class: "bullet-list" }, [
        h("li", { text: "不显示、不缓存、不持久化任何消息正文；日志只有白名单字段。" }),
        h("li", {
          text:
            "实验模式只允许：文本、chatType=private、contentOwner=self 的微信↔QQ 路由；" +
            "拒绝 Telegram、third-party、群聊与媒体（显式提示后跳过）。",
        }),
        h("li", { text: "令牌只存内存：刷新/重启需重新配对/重输；不写 localStorage、不写 URL、不写日志。" }),
        h("li", {
          text:
            "不引入平台登录、个人号协议客户端、群聊、媒体解析能力；CSP 为 default-src 'self'，" +
            "仅 connect-src 放行用户配置的网关 http/ws。",
        }),
        h("li", { text: "无遥测、无崩溃上报、无自动更新。" }),
      ]),
      sectionTitle("模式说明"),
      hint(
        "A（正式）：经桌面端伴生 API 控制转发。转发核心运行在桌面端，手机只是遥控器。" +
          "B（实验，默认关闭）：在 WebView 内直连网关跑受限子集，仅前台运行。" +
          "iOS 仅提供 Capacitor 工程骨架，不提供 IPA（iOS 不允许常驻后台转发）。",
      ),
      sectionTitle("版本"),
      hint(`移动伴生控制端 ${APP_VERSION} · 桌面端伴生 API 契约 0.2.0`),
    ]),
  );
}

// ─────────────────────────────── 启动 ───────────────────────────────

function mountShell(): void {
  const nav = document.getElementById("nav");
  if (nav !== null) {
    nav.replaceChildren();
    for (const item of NAV_ITEMS) {
      nav.append(
        h("button", {
          class: "nav-btn",
          text: item.label,
          attrs: { "data-nav": item.id, type: "button" },
          onClick: () => navigate(item.id),
        }),
      );
    }
  }

  window.addEventListener("hashchange", () => {
    notice = null;
    void render();
  });

  updateHeader();
  void render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountShell, { once: true });
} else {
  mountShell();
}

// Service Worker 只在安全上下文（https / localhost）注册；Capacitor 的 http 源不注册。
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js").catch(() => {
      // 注册失败不影响核心功能（离线外壳是可选增强）。
    });
  });
}
