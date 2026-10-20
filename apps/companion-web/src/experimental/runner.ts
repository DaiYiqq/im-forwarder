/**
 * 【实验模式】前台受限转发循环。
 *
 * 合规边界（红线 2）在这里逐条落到代码：
 *   · 只转发 text（媒体一律"显式提示后跳过"，不解析、不下载、不转 base64）；
 *   · 只处理 chatType=private（群聊显式跳过）；
 *   · 只处理 wechat ↔ qq 的本人路由（路由在进入本模块前已由 routing.ts 校验，
 *     这里再做一次目标平台兜底：telegram 目标在类型层就不存在）；
 *   · 跳过 senderIsSelf / senderIsBot（与核心 policy 一致：自身回显、机器人互触发）。
 *
 * 前台约束：由上层（app.ts）把 `document.visibilitychange` 订阅注入 `visibility`，
 * 页面进入后台/锁屏时**立即停止**并清空内存令牌与指纹表；runner 本身不依赖 DOM，
 * 因此可以在 node:test 里用假 gateway / 假 visibility 完整覆盖。
 *
 * 数据生命周期：正文只存在于 handleMessage 的局部变量 → 渲染结果 → 请求体，
 * 不进入日志、不进入任何存储、不进入 UI。日志条目只包含元数据白名单字段。
 */

import { FingerprintGuard } from "./loop-guard.ts";
import type {
  GatewayChatType,
  GatewayMessageKind,
  GatewayPlatform,
  GatewaySendResult,
  IncomingGatewayMessage,
} from "./gateway.ts";
import { selectTargets, type BModeRoute } from "./routing.ts";
import { renderForTarget } from "./transform.ts";

/** 本模式允许的入站/出站平台（Telegram 不在其中）。 */
export type BModePlatform = "wechat" | "qq";

/** 与核心 ForwardStatus 对齐的状态码；UI 负责翻成中文。 */
export type BModeStatus =
  | "forwarded"
  | "send_failed"
  | "skipped_echo"
  | "skipped_self"
  | "skipped_bot"
  | "skipped_unsupported_kind"
  | "skipped_group_forbidden"
  | "skipped_telegram_forbidden"
  | "skipped_no_route"
  | "skipped_loop_suspected"
  | "skipped_empty";

export interface RunnerCounters {
  forwarded: number;
  failed: number;
  skipped: number;
}

/** 元数据日志（白名单字段，绝无正文/会话 ID）。 */
export interface RunnerLogEntry {
  ts: number;
  status: BModeStatus;
  routeId?: string;
  sourcePlatform?: GatewayPlatform;
  targetPlatform?: GatewayPlatform;
  kind?: GatewayMessageKind;
  errorCode?: string;
  truncated?: boolean;
  /** 仅当转发成功且网关返回 messageId 时记录（用于回显识别，不是内容）。 */
  messageId?: string;
}

export interface RunnerNotice {
  ts: number;
  /** 可直接展示的中文说明（不含正文）。 */
  text: string;
}

export interface RunnerView {
  running: boolean;
  connected: boolean;
  counters: RunnerCounters;
  logs: readonly RunnerLogEntry[];
  notices: readonly RunnerNotice[];
  lastError: string | null;
  stoppedReason: string | null;
}

/** 供 runner 使用的最小网关接口（真实实现是 GatewayClient，测试可注入假实现）。 */
export interface GatewayPort {
  connect(): Promise<void>;
  close(): void;
  sendText(input: {
    platform: GatewayPlatform;
    conversationId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<GatewaySendResult>;
}

export interface GatewayStatusLike {
  state: string;
  code: string | null;
}

/** 前台/后台信号源（浏览器实现由 app.ts 提供；测试可用假实现）。 */
export interface VisibilityPort {
  subscribe(onHidden: () => void): () => void;
}

export interface BModeRunnerOptions {
  routes: readonly BModeRoute[];
  /** 每次 start 创建一个全新网关实例（令牌只在实例内存里）。 */
  createGateway: (callbacks: {
    onMessage: (message: IncomingGatewayMessage) => void;
    onStatus: (status: GatewayStatusLike) => void;
  }) => GatewayPort;
  /** 每次 start 创建一个全新指纹防护（盐随机、停止即丢弃）。 */
  createGuard?: () => FingerprintGuard;
  onUpdate: (view: RunnerView) => void;
  /** 页面切后台时由 app.ts 触发停止；默认不提供（纯逻辑测试可省略）。 */
  visibility?: VisibilityPort;
  now?: () => number;
  maxLogs?: number;
  maxNotices?: number;
}

const DEFAULT_MAX_LOGS = 20;
const DEFAULT_MAX_NOTICES = 5;

function createDefaultGuard(): FingerprintGuard {
  return new FingerprintGuard();
}

export class BModeRunner {
  private readonly options: BModeRunnerOptions;
  private readonly now: () => number;
  private readonly maxLogs: number;
  private readonly maxNotices: number;

  private running = false;
  private connected = false;
  private stopping = false;
  private gateway: GatewayPort | null = null;
  private guard: FingerprintGuard | null = null;
  private unsubscribeVisibility: (() => void) | null = null;

  private counters: RunnerCounters = { forwarded: 0, failed: 0, skipped: 0 };
  private logs: RunnerLogEntry[] = [];
  private notices: RunnerNotice[] = [];
  private lastError: string | null = null;
  private stoppedReason: string | null = null;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: BModeRunnerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.maxLogs = options.maxLogs ?? DEFAULT_MAX_LOGS;
    this.maxNotices = options.maxNotices ?? DEFAULT_MAX_NOTICES;
  }

  get isRunning(): boolean {
    return this.running;
  }

  view(): RunnerView {
    return {
      running: this.running,
      connected: this.connected,
      counters: { ...this.counters },
      logs: [...this.logs],
      notices: [...this.notices],
      lastError: this.lastError,
      stoppedReason: this.stoppedReason,
    };
  }

  /**
   * 启动：创建指纹表、连接网关、订阅前台信号。
   * 连接失败时立即清理（关闭网关 = 清空令牌 + 清空指纹表）并抛出可读错误。
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.lastError = null;
    this.stoppedReason = null;
    this.counters = { forwarded: 0, failed: 0, skipped: 0 };
    this.logs = [];
    this.notices = [];
    this.sequence = 0;

    this.guard = (this.options.createGuard ?? createDefaultGuard)();
    this.gateway = this.options.createGateway({
      onMessage: (message) => this.enqueue(message),
      onStatus: (status) => {
        this.connected = status.state === "open";
        this.emit();
      },
    });

    this.running = true;
    this.emit();

    this.unsubscribeVisibility =
      this.options.visibility?.subscribe(() => {
        void this.stop("页面已切到后台（或锁屏），实验模式已立即停止");
      }) ?? null;

    try {
      await this.gateway.connect();
      this.connected = true;
      this.emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : "网关连接失败";
      this.lastError = message;
      await this.stop(message);
      throw new Error(message);
    }
  }

  /**
   * 停止：断开网关（令牌清零）+ 清空指纹表 + 退订前台信号。
   * 计数与元数据日志保留供用户回看；正文从未被保存。
   */
  async stop(reason: string): Promise<void> {
    if (!this.running && !this.stopping) {
      this.stoppedReason = reason;
      this.emit();
      return;
    }
    this.stopping = true;
    this.running = false;

    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;

    this.gateway?.close();
    this.gateway = null;
    this.connected = false;

    this.guard?.clear();
    this.guard = null;

    this.stoppedReason = reason;
    this.stopping = false;
    this.emit();
  }

  /** 入站消息串行处理，保证回显/指纹判定顺序稳定。 */
  private enqueue(message: IncomingGatewayMessage): void {
    this.queue = this.queue
      .then(() => this.handleMessage(message))
      .catch(() => {
        // 处理异常不打断循环：只记录错误码，不打印任何内容。
        this.pushLog({ ts: this.now(), status: "send_failed", errorCode: "handler_error" });
        this.counters.failed += 1;
        this.emit();
      });
  }

  /**
   * 单条消息的完整判定（public 便于单元测试直接调用）。
   * 所有跳过分支都会留下元数据日志，媒体/群聊/Telegram 还会产生显式提示。
   */
  async handleMessage(message: IncomingGatewayMessage): Promise<void> {
    if (!this.running) return;

    // 兜底：Telegram 平台消息（理论上在 routing 校验后被拒，这里再挡一次）。
    if (message.platform !== "wechat" && message.platform !== "qq") {
      this.skip("skipped_telegram_forbidden", message, undefined, "skipped: 已跳过非微信/QQ 平台消息（实验模式拒绝 Telegram）");
      return;
    }

    if (message.senderIsSelf) {
      this.skip("skipped_self", message);
      return;
    }
    if (message.senderIsBot) {
      this.skip("skipped_bot", message);
      return;
    }

    if (message.kind !== "text" || message.text === null) {
      this.skip(
        "skipped_unsupported_kind",
        message,
        undefined,
        `skipped: 已跳过一条非文本消息（${message.kind}；实验模式不解析媒体）`,
      );
      return;
    }

    if (message.chatType !== "private") {
      this.skip("skipped_group_forbidden", message, undefined, "skipped: 已跳过群聊消息（实验模式仅支持私聊）");
      return;
    }

    const targets = selectTargets(this.options.routes, {
      platform: message.platform,
      conversationId: message.conversationId,
      chatType: message.chatType,
    });
    if (targets.length === 0) {
      this.skip("skipped_no_route", message);
      return;
    }

    const guard = this.guard;
    if (guard === null) return;

    // 第 1 层：目标侧 messageId 回显。
    if (
      guard.lookupEcho({
        platform: message.platform,
        conversationId: message.conversationId,
        messageId: message.messageId,
      })
    ) {
      this.skip("skipped_echo", message);
      return;
    }

    const sourceText = message.text;

    for (const { route, target } of targets) {
      if (guard === null) return;

      // 第 2 层：短期内容指纹（同 group 窗口内相同文本 ⇒ 疑似回环）。
      if (await guard.isFingerprintLoop(route.group, sourceText)) {
        this.skip("skipped_loop_suspected", message, route.id);
        return;
      }

      const rendered = renderForTarget({ text: sourceText, targetPlatform: target.platform });
      if (rendered.text.length === 0) {
        this.skip("skipped_empty", message, route.id);
        return;
      }

      const idempotencyKey = this.nextIdempotencyKey(route.id, message.messageId, target.platform);
      let outcome: GatewaySendResult;
      try {
        outcome = await this.gatewaySend(target.platform, target.conversationId, rendered.text, idempotencyKey);
      } catch {
        outcome = { ok: false, messageId: null, errorCode: "gateway_network" };
      }

      if (!outcome.ok) {
        this.counters.failed += 1;
        this.pushLog({
          ts: this.now(),
          status: "send_failed",
          routeId: route.id,
          sourcePlatform: message.platform,
          targetPlatform: target.platform,
          kind: message.kind,
          ...(outcome.errorCode === null ? {} : { errorCode: outcome.errorCode }),
        });
        this.emit();
        continue;
      }

      // 回环防护登记（只登记 messageId 与 HMAC 指纹）。
      if (outcome.messageId !== null) {
        guard.rememberEcho({
          platform: target.platform,
          conversationId: target.conversationId,
          messageId: outcome.messageId,
        });
      }
      await guard.rememberFingerprint(route.group, rendered.text);

      this.counters.forwarded += 1;
      this.pushLog({
        ts: this.now(),
        status: "forwarded",
        routeId: route.id,
        sourcePlatform: message.platform,
        targetPlatform: target.platform,
        kind: message.kind,
        ...(rendered.truncated ? { truncated: true } : {}),
        ...(outcome.messageId === null ? {} : { messageId: outcome.messageId }),
      });
      this.emit();
    }
  }

  private async gatewaySend(
    platform: GatewayPlatform,
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<GatewaySendResult> {
    const gateway = this.gateway;
    if (gateway === null) return { ok: false, messageId: null, errorCode: "gateway_not_connected" };
    return await gateway.sendText({ platform, conversationId, text, idempotencyKey });
  }

  /** 跳过：计数 + 元数据日志 +（可选）中文提示。 */
  private skip(
    status: BModeStatus,
    message: IncomingGatewayMessage,
    routeId?: string,
    notice?: string,
  ): void {
    this.counters.skipped += 1;
    this.pushLog({
      ts: this.now(),
      status,
      ...(routeId === undefined ? {} : { routeId }),
      sourcePlatform: message.platform,
      kind: message.kind,
    });
    if (notice !== undefined) {
      this.pushNotice(notice);
      this.lastError = notice;
    }
    this.emit();
  }

  private nextIdempotencyKey(routeId: string, messageId: string, platform: string): string {
    this.sequence += 1;
    // 只在内存中生成；不参与展示。长度上限保守控制在 128 字符内。
    return `b${this.now().toString(36)}${this.sequence.toString(36)}-${routeId}-${platform}-${messageId}`.slice(0, 128);
  }

  private pushLog(entry: RunnerLogEntry): void {
    this.logs = [...this.logs, entry].slice(-this.maxLogs);
  }

  private pushNotice(text: string): void {
    this.notices = [...this.notices, { ts: this.now(), text }].slice(-this.maxNotices);
  }

  private emit(): void {
    this.options.onUpdate(this.view());
  }
}

/** 供 app.ts 复用的平台/状态中文展示映射。 */
export const B_MODE_PLATFORM_LABELS: Record<BModePlatform, string> = {
  wechat: "微信",
  qq: "QQ",
};

export const B_MODE_STATUS_LABELS: Record<BModeStatus, string> = {
  forwarded: "已转发",
  send_failed: "发送失败",
  skipped_echo: "跳过：自身回显",
  skipped_self: "跳过：自己发出的消息",
  skipped_bot: "跳过：机器人消息",
  skipped_unsupported_kind: "跳过：非文本",
  skipped_group_forbidden: "跳过：群聊",
  skipped_telegram_forbidden: "跳过：Telegram",
  skipped_no_route: "跳过：无匹配路由",
  skipped_loop_suspected: "跳过：疑似回环",
  skipped_empty: "跳过：空内容",
};

/** 仅用于类型收敛：确认实验模式的会话类型只可能是 private。 */
export type BModeChatType = Extract<GatewayChatType, "private">;
