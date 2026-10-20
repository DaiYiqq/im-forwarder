/**
 * 【实验模式·受限文本渲染】—— 复制自仓库核心 `src/pipeline/transform.ts`。
 *
 * 为什么复制而不是跨包 import：
 *  - 浏览器端独立构建（esbuild）需要自包含模块；跨包相对路径会跨越 app 边界，
 *    让移动端构建依赖桌面端/服务端的目录结构，不利于单独发布；
 *  - 核心模块 import 的是 `src/types.ts` 里的 `Platform`（含 telegram），
 *    而实验模式从类型上就不允许 telegram，直接复用会把禁区类型带进移动端包。
 *
 * 复制只做两处改动（逻辑与核心保持逐行对应，避免行为漂移）：
 *  1. 平台类型收窄为 `"wechat" | "qq"`（实验模式只允许微信 ↔ QQ）；
 *  2. 删除 telegram 分支与 telegram 长度上限。
 *
 * 来源版本：im-forwarder 0.2.0 `src/pipeline/transform.ts`（CQ 转义 + 截断）。
 * 回归：test/transform.spec.ts 覆盖「CQ 码注入必须被转义」「截断不切断转义实体」。
 *
 * 唯一职责仍然是：清洗、截断、按目标平台做必要转义。
 * 绝不做：表情包解析、富文本/Markdown 重排、链接抓取、媒体下载、内容改写。
 */

/** 实验模式允许的平台。 */
export type TextTargetPlatform = "wechat" | "qq";

/** 各平台文本长度上限（保守值；超长截断并保证不切断转义实体）。 */
export const PLATFORM_TEXT_LIMITS: Record<TextTargetPlatform, number> = {
  wechat: 2000,
  qq: 4500,
};

const TRUNCATION_SUFFIX = "…(已截断)";

/** 去控制字符（保留换行与制表符），统一换行，去首尾空白。 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
}

/**
 * OneBot / NapCat 的 CQ 码转义。
 * 顺序很重要：先转义 `&`，否则会把后面生成的实体的 `&` 再转一次。
 *
 * 为什么必须转义：对方发一句 `[CQ:at,qq=all]`，若原样拼进 QQ 消息就会变成 @全体成员。
 * 本模式永远只构造 text 片段，不会根据来源内容生成 at/image/face 等任何其它片段。
 */
export function escapeCqCodes(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/\[/gu, "&#91;").replace(/\]/gu, "&#93;");
}

/** 普通截断：按 UTF-16 码元切，可能与 emoji 边界相交，属可接受降级。 */
export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const keep = Math.max(0, limit - TRUNCATION_SUFFIX.length);
  return { text: `${text.slice(0, keep)}${TRUNCATION_SUFFIX}`, truncated: true };
}

/**
 * CQ 转义 + 截断（一次完成）。
 * 必须边转义边计数：先截断再转义会让长度膨胀超限；先转义再截断会把 `&#91;` 切成 `&#9`。
 */
export function escapeCqCodesBounded(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  const budget = Math.max(0, limit - TRUNCATION_SUFFIX.length);
  let output = "";
  for (const char of text) {
    const piece = char === "&" ? "&amp;" : char === "[" ? "&#91;" : char === "]" ? "&#93;" : char;
    if (output.length + piece.length > budget) {
      return { text: `${output}${TRUNCATION_SUFFIX}`, truncated: true };
    }
    output += piece;
  }
  return { text: output, truncated: false };
}

export interface RenderInput {
  text: string;
  targetPlatform: TextTargetPlatform;
}

export interface RenderResult {
  text: string;
  truncated: boolean;
}

/**
 * 渲染为目标平台可安全发送的文本。
 *
 * 不添加任何"来自 XX 平台"的前缀（前缀会被当成对方原话的一部分，多跳还会叠加）。
 * 也不做任何"看起来像引用/转发"的包装，避免伪造上下文。
 */
export function renderForTarget(input: RenderInput): RenderResult {
  const limit = PLATFORM_TEXT_LIMITS[input.targetPlatform];
  const normalized = normalizeText(input.text);
  if (normalized.length === 0) {
    return { text: "", truncated: false };
  }
  if (input.targetPlatform === "qq") {
    return escapeCqCodesBounded(normalized, limit);
  }
  return truncate(normalized, limit);
}
