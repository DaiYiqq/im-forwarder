# Translations / 翻译 / 翻訳

Language policy for this project's user-facing documents.

## 1. Which language is canonical?

**English (`README.md`) is canonical.** All other languages are best-effort, community-maintained
translations. If a translation disagrees with the English text, the English text wins.

Rationale: one canonical version avoids "the Chinese README says it is allowed but the English one
forbids it" style inconsistencies, which are exactly the kind of ambiguity a compliance-oriented
project must avoid.

## 2. Status

| Language | File | Status | Maintainer |
|---|---|---|---|
| English | [README.md](README.md) | ✅ canonical, complete | [@DaiYiqq](https://github.com/DaiYiqq) |
| 简体中文 | [README.zh-CN.md](README.zh-CN.md) | ✅ complete | [@DaiYiqq](https://github.com/DaiYiqq) |
| 日本語 | [README.ja.md](README.ja.md) | 🟡 best effort (translated from zh-CN) | *open — PRs welcome* |
| others | — | ⬜ not started | *open — PRs welcome* |

Legend: ✅ complete and maintained · 🟡 complete but may lag behind · ⬜ started/absent.

> Chinese-language long-form docs (`COMPLIANCE.md`, `docs/*.md`) are maintained in Chinese only for
> now. Translating them is welcome but must be listed here; the English README links to them with a
> `(Chinese)` note.

## 3. Non-negotiable content in every language

A translated README **must** keep, with the same meaning and comparable prominence:

1. the **non-commercial** warning directly after the title (no paid services / paid hosting / resale);
2. all **seven risk warnings** (research-only, WeChat official iLink + private-only, NapCat
   non-official + account-ban + burner account, Telegram official Bot API only + no userbot,
   cross-border PIPL Art. 38/39 + default off, network-access legality, disclaimer);
3. the **developer contact** table (all channels listed in [CONTACT.md](CONTACT.md));
4. the **community / contributing** section and the **license** section;
5. the "not affiliated with Tencent/QQ/Telegram" note.

If a translation shortens or softens any of these, it will be reverted.

## 4. How to add a language

1. Copy `README.md` to `README.<BCP-47 tag>.md` (e.g. `README.zh-TW.md`, `README.ko.md`,
   `README.es.md`, `README.de.md`). Use lowercase tags as in the file name.
2. Translate **every** section; keep code blocks, YAML keys and file paths unchanged.
3. Update the language switcher line at the top of **all** README files, in the same order:
   `[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | ...`
4. Add a row to the table in §2 of this file (language, file, status, your GitHub handle).
5. Open a PR titled `docs(i18n): add <language> README`.
6. If you cannot maintain it, add `<!-- needs-translation -->` markers rather than guessing.

## 5. Keeping translations fresh

- When a PR changes `README.md`, the author must update the translation **or** add
  `<!-- needs-translation -->` at the top of the affected translated files and open an issue
  labelled `translation`.
- A monthly check (by any maintainer) compares section headings of all README files; missing
  sections get a `translation` issue.
- If a translation falls more than one minor version behind, §2 status becomes 🟡 / ⬜.

## 6. Style notes

- Keep the English technical terms in parentheses where a local term is ambiguous
  (e.g. 出境（cross-border transfer）、网关（gateway）).
- Do not translate the project name, file names, config keys, or log field names.
- Use the polite/neutral register of the target language; avoid marketing tone — the project is
  deliberately conservative about its claims.
- Numbers, exit codes and error codes are never localized (`EXIT 78`, `WECHAT_GROUP_SOURCE_FORBIDDEN`).

---

## 中文摘要

- **以英文 README 为准**，其它语言为社区尽力维护；冲突时以英文为准。
- 任何语言的 README 都必须保留：**非商用声明**、7 条风险提示、**开发者联系方式**、
  社区贡献段落、许可证段落、"与腾讯/QQ/Telegram 无隶属关系"声明。
- 新增语言：复制 `README.md` → `README.<语言标签>.md` → 翻译全部章节 → 更新所有 README 顶部语言切换 →
  在本文 §2 表格登记 → PR 标题 `docs(i18n): add <language> README`。
- 英文 README 变更时，作者须同步翻译或加 `<!-- needs-translation -->` 并开 `translation` Issue。
- 不翻译：项目名、文件名、配置键、日志字段名、退出码与错误码。
