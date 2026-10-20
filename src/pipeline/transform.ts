/**
 * 纯内存文本转换。
 *
 * 只做三件事：清洗、截断、按目标平台做必要的**转义**。
 * 绝不做：表情包解析、富文本/Markdown 重排、链接抓取、媒体下载、内容改写。
 *
 * 安全重点是 CQ 码注入：
 *   OneBot(NapCat) 用 `[CQ:...]` 表示消息片段。如果直接把来源文本拼进 QQ 消息，
 *   对方发一句 `[CQ:at,qq=all]` 就可能变成 @全体成员。
 *   因此发往 QQ 的文本必须做 CQ 转义，且本服务**永远只构造 text 片段**，
 *   不会根据来源内容生成 at/image/face 等任何其它片段。
 */

import type { Platform } from "../types";

/** 各平台文本长度上限（保守值；超长截断并保证不切断转义实体）。 */
export const PLATFORM_TEXT_LIMITS: Record<Platform, number> = {
  wechat: 2000,
  qq: 4500,
  telegram: 4096,
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
 */
export function escapeCqCodes(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/\[/gu, "&#91;").replace(/\]/gu, "&#93;");
}

/** 普通截断：保留语义完整的字符序列（JS 字符串按 UTF-16 码元切，可能与 emoji 边界相交，属可接受降级）。 */
export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const keep = Math.max(0, limit - TRUNCATION_SUFFIX.length);
  return { text: `${text.slice(0, keep)}${TRUNCATION_SUFFIX}`, truncated: true };
}

/**
 * CQ 转义 + 截断（一次完成）。
 * 必须边转义边计数，否则"先截断再转义"会让最终长度膨胀数倍并超过平台上限，
 * 而"先转义再截断"又可能把 `&#91;` 切成 `&#9`，留下半截实体。
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
  target: { platform: Platform };
}

export interface RenderResult {
  text: string;
  truncated: boolean;
}

/**
 * 渲染为目标平台可安全发送的文本。
 *
 * 说明：不添加任何"来自 XX 平台"的前缀。前缀会被接收方误当成对方原话的一部分，
 * 且多跳转发时会不断叠加。需要溯源请查日志中的 routeId。
 * 也不做任何"看起来像引用/转发"的包装，避免伪造上下文。
 */
export function renderForTarget(input: RenderInput): RenderResult {
  const limit = PLATFORM_TEXT_LIMITS[input.target.platform];
  const normalized = normalizeText(input.text);
  if (normalized.length === 0) {
    return { text: "", truncated: false };
  }
  if (input.target.platform === "qq") {
    return escapeCqCodesBounded(normalized, limit);
  }
  return truncate(normalized, limit);
}
