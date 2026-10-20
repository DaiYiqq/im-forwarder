/**
 * 面向"源会话"的回执文案。
 *
 * 这些文本是**本服务生成的**，不是用户内容，因此可以出现在日志参数里（但我们仍然不打）。
 * 关键约束：
 *  · 缺省一律"不转发"，先告知；
 *  · 告知必须覆盖 PIPL 第 23 条要求的全部要素（接收方名称/联系方式/目的/方式/种类/期限）；
 *  · 必须告诉对方"怎么撤回"；
 *  · 不承诺任何本服务做不到的事（例如"已删除对方服务器上的副本"）。
 */

import type { CompiledRoute } from "../routing/matrix";
import type { MessageKind } from "../types";
import type { ConsentScope } from "../compliance/consent";

function listTargets(route: CompiledRoute): string[] {
  return route.to.map((target, index) => {
    const receiver = target.receiver;
    const head = `  ${index + 1}) 接收方：${receiver?.name ?? `${target.platform}（会话 ${target.conversationId}）`}`;
    const lines = [head];
    if (receiver) {
      lines.push(`     联系方式：${receiver.contact}`);
      lines.push(`     处理目的：${receiver.purpose}`);
      lines.push(`     处理方式：${receiver.method}`);
      lines.push(`     信息种类：${receiver.dataCategories.join("、")}`);
      lines.push(`     保存期限：${receiver.retention}`);
    }
    return lines.join("\n");
  });
}

export interface ConsentNoticeInput {
  route: CompiledRoute;
  noticeVersion: string;
  keyword: string;
  revokeKeywords: string[];
}

/** PIPL 第 23 条：向其他处理者提供个人信息的告知 + 单独同意提示。 */
export function domesticConsentNotice(input: ConsentNoticeInput): string {
  return [
    "【转发告知 · 需你同意】",
    "你发送的消息默认不会转发。若你同意，本工具会把你的文本消息转发给以下接收方：",
    ...listTargets(input.route),
    "",
    "本工具只转发文本；不保存消息正文，不记录到日志；转发后你随时可以撤回同意。",
    `如果你同意，请回复「${input.keyword}」（需单独一条消息，且仅本会话生效）。`,
    `随时可回复「${input.revokeKeywords[0] ?? "撤回同意"}」撤回，撤回后本会话不再转发。`,
    `（告知版本：${input.noticeVersion}）`,
  ].join("\n");
}

/** PIPL 第 39 条：向境外提供个人信息的告知 + 单独同意提示。 */
export function crossBorderConsentNotice(input: ConsentNoticeInput): string {
  return [
    "【数据出境告知 · 需你单独同意】",
    "上述接收方中有一方位于境外（Telegram，服务器在境外）。",
    "向境外提供你的个人信息可能构成《个人信息保护法》第三十八条所称的出境行为。",
    "境外接收方信息与处理说明：",
    ...listTargets(input.route),
    "",
    "出境后，你依据《个人信息保护法》第四章享有的权利（查阅、复制、更正、删除、转移等）",
    "可能难以向境外接收方直接行使。本工具不代为完成第三十八条要求的安全评估/标准合同/保护认证。",
    "如果你已被告知上述风险并单独同意出境，请回复「" +
      `${input.keyword}」（与上一步的同意是两次独立的同意）。`,
    `随时可回复「${input.revokeKeywords[0] ?? "撤回同意"}」撤回全部同意。`,
    `（告知版本：${input.noticeVersion}）`,
  ].join("\n");
}

export function consentRecordedNotice(scope: ConsentScope, withCrossBorderPending: boolean): string {
  if (scope === "domestic") {
    return withCrossBorderPending
      ? "已记录你的「同意转发」。该链路还涉及境外接收方，需要你**再次单独同意**出境，请回复出境确认关键词。"
      : "已记录你的「同意转发」。之后本会话的文本消息将被转发；回复「撤回同意」可随时停止。";
  }
  return "已记录你的「单独同意出境」。之后本会话的文本消息将被转发至境外接收方；回复「撤回同意」可随时停止。";
}

export function consentAlreadyGrantedNotice(): string {
  return "该同意此前已记录，无需重复操作。回复「撤回同意」可随时停止。";
}

export function consentRevokedNotice(hadRecord: boolean): string {
  return hadRecord
    ? "已撤回同意，本会话后续消息不再转发。已经转发出去的消息无法追回。"
    : "本会话当前没有有效的同意记录，无需撤回。";
}

export function crossBorderGrantNeedsDomesticNotice(domesticKeyword: string): string {
  return `出境同意需要与境内转发同意分别作出。请先回复「${domesticKeyword}」表示同意转发，再单独回复出境确认。`;
}

export function crossBorderNotNeededNotice(): string {
  return "当前链路的目标都在境内，不涉及数据出境，无需出境同意。";
}

export function notReadyNotice(): string {
  return "转发功能暂时不可用，本条消息未被转发。请稍后再试或联系维护者。";
}

/** 不支持的消息类型：显式回执，绝不静默丢弃。 */
export function unsupportedKindNotice(kind: MessageKind): string {
  return [
    `本条消息的类型为「${kind}」，暂不支持跨平台转发，已跳过。`,
    "本工具只转发文本消息：不下载、不解析、不转换图片/语音/视频/文件/表情等媒体内容。",
  ].join("\n");
}
