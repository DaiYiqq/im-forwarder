/**
 * 【实验模式】路由 JSON 校验 —— 合规红线的代码化。
 *
 * 只允许下面这一种子集（其余一律**拒绝**，不做"尽力而为"的降级）：
 *   · 平台：仅 wechat / qq（拒绝 Telegram，无论出境还是入境）；
 *   · 会话：仅 private（拒绝群聊）；
 *   · 内容归属：仅 contentOwner = "self"（拒绝他人聊天内容）；
 *   · 方向：微信 ↔ QQ（源与目标平台必须不同，即不引入 Telegram/微博等第三方）。
 *
 * 校验是 fail-closed 的：只要出现任何 violation，返回的 `routes` 必为空数组，
 * 调用方拿到非空 violations 时必须拒绝启动。所有 violations 都是可直接展示给用户的中文说明。
 *
 * 本模块不依赖 DOM、不读存储、不碰网络 —— 便于 node:test 直接覆盖。
 */

export type BModePlatform = "wechat" | "qq";

export interface BModeEndpoint {
  platform: BModePlatform;
  conversationId: string;
  chatType: "private";
}

export interface BModeRoute {
  id: string;
  group: string;
  contentOwner: "self";
  from: BModeEndpoint;
  to: BModeEndpoint[];
}

export interface RouteValidationResult {
  /** 仅在 violations 为空时非空。 */
  routes: BModeRoute[];
  violations: string[];
}

/** 实验模式路由条数上限：手机端只做"少量本人链路"的临时转发。 */
export const MAX_BMODE_ROUTES = 16;

const ROUTE_KEYS = new Set(["id", "group", "contentOwner", "from", "to"]);
const ENDPOINT_KEYS = new Set(["platform", "conversationId", "chatType"]);
const ALLOWED_PLATFORMS = new Set<BModePlatform>(["wechat", "qq"]);
const MAX_CONVERSATION_ID_LENGTH = 128;
const MAX_ID_LENGTH = 64;
const MAX_GROUP_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function controlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * 校验单个端点，返回端点本身或一条中文 violation。
 * 注意：所有"不支持"的分支都要给出**明确原因**，不能静默跳过 ——
 * 用户必须能看懂"为什么这条路由被拒绝"。
 */
function validateEndpoint(raw: unknown, where: string, violations: string[]): BModeEndpoint | null {
  if (!isRecord(raw)) {
    violations.push(`${where}：端点必须是对象`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!ENDPOINT_KEYS.has(key)) {
      violations.push(`${where}：不允许的字段 "${key}"（实验模式不接受未知字段）`);
    }
  }

  const platform = raw["platform"];
  if (platform === "telegram") {
    violations.push(`${where}：实验模式拒绝 Telegram 路由（不支持任何出境/入境 Telegram 链路）`);
    return null;
  }
  if (platform !== "wechat" && platform !== "qq") {
    violations.push(`${where}：不支持的平台 ${String(platform)}（仅允许 wechat / qq）`);
    return null;
  }

  const chatType = raw["chatType"];
  if (chatType === "group") {
    violations.push(`${where}：实验模式拒绝群聊路由（仅允许 chatType=private）`);
    return null;
  }
  if (chatType !== "private") {
    violations.push(`${where}：chatType 只允许 "private"，收到 ${String(chatType)}`);
    return null;
  }

  const conversationId = raw["conversationId"];
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    violations.push(`${where}：conversationId 必须是非空字符串`);
    return null;
  }
  if (conversationId.length > MAX_CONVERSATION_ID_LENGTH) {
    violations.push(`${where}：conversationId 过长（上限 ${MAX_CONVERSATION_ID_LENGTH} 字符）`);
    return null;
  }
  if (controlChars(conversationId)) {
    violations.push(`${where}：conversationId 含控制字符`);
    return null;
  }

  return { platform, conversationId, chatType: "private" };
}

/**
 * 校验路由数组。
 * 传 `unknown` 而不是 `RouteConfig`：数据来自用户手输的 JSON，必须先当成不可信输入校验。
 */
export function validateBModeRoutes(input: unknown): RouteValidationResult {
  const violations: string[] = [];
  const routes: BModeRoute[] = [];

  if (!Array.isArray(input)) {
    return { routes: [], violations: ["路由必须是 JSON 数组，例如 [{ id, group, contentOwner, from, to }]"] };
  }
  if (input.length === 0) {
    return { routes: [], violations: ["至少需要一条路由"] };
  }
  if (input.length > MAX_BMODE_ROUTES) {
    return { routes: [], violations: [`实验模式最多允许 ${MAX_BMODE_ROUTES} 条路由（收到 ${input.length} 条）`] };
  }

  const seenIds = new Set<string>();

  input.forEach((raw, index) => {
    const where = `第 ${index + 1} 条路由`;
    if (!isRecord(raw)) {
      violations.push(`${where}：必须是对象`);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!ROUTE_KEYS.has(key)) {
        violations.push(`${where}：不允许的字段 "${key}"（实验模式不接受未知字段）`);
      }
    }

    const id = raw["id"];
    if (typeof id !== "string" || id.trim().length === 0) {
      violations.push(`${where}：id 必须是非空字符串`);
      return;
    }
    if (id.length > MAX_ID_LENGTH) {
      violations.push(`${where}：id 过长（上限 ${MAX_ID_LENGTH} 字符）`);
      return;
    }
    if (controlChars(id)) {
      violations.push(`${where}：id 含控制字符`);
      return;
    }
    if (seenIds.has(id)) {
      violations.push(`${where}：路由 id 重复（${id}）`);
      return;
    }
    seenIds.add(id);

    const group = raw["group"];
    if (typeof group !== "string" || group.trim().length === 0) {
      violations.push(`${where}：group 必须是非空字符串（回环防护以 group 为单位）`);
      return;
    }
    if (group.length > MAX_GROUP_LENGTH) {
      violations.push(`${where}：group 过长（上限 ${MAX_GROUP_LENGTH} 字符）`);
      return;
    }

    const owner = raw["contentOwner"];
    if (owner === "third-party") {
      violations.push(`${where}：实验模式拒绝 contentOwner=third-party（不转发他人聊天内容）`);
      return;
    }
    if (owner !== "self") {
      violations.push(`${where}：contentOwner 只允许 "self"，收到 ${String(owner)}`);
      return;
    }

    const from = validateEndpoint(raw["from"], `${where} 的 from`, violations);
    const toRaw = raw["to"];
    if (!Array.isArray(toRaw) || toRaw.length === 0) {
      violations.push(`${where}：to 必须是非空数组`);
      return;
    }
    const to: BModeEndpoint[] = [];
    toRaw.forEach((target, targetIndex) => {
      const endpoint = validateEndpoint(target, `${where} 的 to[${targetIndex}]`, violations);
      if (endpoint !== null) to.push(endpoint);
    });

    if (from === null || to.length !== toRaw.length) return;

    // 源与目标必须跨平台（微信 ↔ QQ）；同平台路由在本实验模式下没有意义且会放大回环风险。
    for (const target of to) {
      if (target.platform === from.platform) {
        violations.push(
          `${where}：源与目标平台必须不同（仅微信 ↔ QQ），收到 ${from.platform} → ${target.platform}`,
        );
        return;
      }
    }
    const targetKeys = new Set<string>();
    for (const target of to) {
      const key = `${target.platform}:${target.conversationId}:${target.chatType}`;
      if (targetKeys.has(key)) {
        violations.push(`${where}：目标端点重复（${key}）`);
        return;
      }
      targetKeys.add(key);
    }

    routes.push({ id, group, contentOwner: "self", from, to });
  });

  if (violations.length > 0) {
    return { routes: [], violations };
  }
  return { routes, violations: [] };
}

/**
 * 解析并校验用户粘贴的路由 JSON。
 * JSON 语法错误也归入 violations，方便 UI 逐条展示。
 */
export function parseBModeRoutes(json: string): RouteValidationResult {
  const trimmed = json.trim();
  if (trimmed.length === 0) {
    return { routes: [], violations: ["路由 JSON 为空"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { routes: [], violations: ["路由 JSON 语法错误，无法解析"] };
  }
  return validateBModeRoutes(parsed);
}

/** 命中的目标集合：只按源端点精确匹配（平台 + 会话 ID）。 */
export interface MatchedTarget {
  route: BModeRoute;
  target: BModeEndpoint;
}

/**
 * 查找某条入站消息应当转发到的目标。
 * 只做精确匹配：平台 + conversationId + private，绝不按前缀/模糊匹配（防止误转发到别的会话）。
 */
export function selectTargets(
  routes: readonly BModeRoute[],
  source: { platform: BModePlatform; conversationId: string; chatType: "private" | "group" },
): MatchedTarget[] {
  if (source.chatType !== "private") return [];
  const matched: MatchedTarget[] = [];
  for (const route of routes) {
    if (route.from.platform !== source.platform) continue;
    if (route.from.conversationId !== source.conversationId) continue;
    for (const target of route.to) {
      matched.push({ route, target });
    }
  }
  return matched;
}
