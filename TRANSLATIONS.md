# Translations / 翻译 / 翻訳

Language policy for this project's user-facing documents.

## 1. Which language is canonical?

**简体中文 (`README.md`) is canonical** — it is also the version GitHub displays by default.
English (`README.en.md`) is the reference translation for international contributors;
日本語 (`README.ja.md`) and 繁體中文 (`README.zh-TW.md`) are community-maintained translations.

Long-form documents:

| Document | Chinese (canonical) | English |
|---|---|---|
| README | `README.md` | `README.en.md` |
| Compliance | `COMPLIANCE.md` | `docs/en/COMPLIANCE.en.md` |
| Routing | `docs/ROUTING.md` | `docs/en/ROUTING.en.md` |
| Gateway contract | `docs/GATEWAY-CONTRACT.md` | `docs/en/GATEWAY-CONTRACT.en.md` |
| Consent flow | `docs/CONSENT-FLOW.md` | `docs/en/CONSENT-FLOW.en.md` |
| Operations | `docs/OPERATIONS.md` | `docs/en/OPERATIONS.en.md` |
| Audit | `docs/AUDIT.md` | `docs/en/AUDIT.en.md` (summary) |

Rationale: the primary audience and the platform terms are Chinese-language; and one canonical version
avoids "the Chinese README says it is allowed but the English one forbids it" inconsistencies. When a
translation conflicts with the canonical text, **the Simplified Chinese text prevails**.

## 2. Status

| Language | File | Status | Maintainer |
|---|---|---|---|
| 简体中文 | [README.md](README.md) | ✅ **canonical**, complete | [@DaiYiqq](https://github.com/DaiYiqq) |
| English | [README.en.md](README.en.md) | ✅ complete (reference translation) | [@DaiYiqq](https://github.com/DaiYiqq) |
| 日本語 | [README.ja.md](README.ja.md) | 🟡 complete, best effort | *open — PRs welcome* |
| 繁體中文 | [README.zh-TW.md](README.zh-TW.md) | 🟡 complete, best effort | *open — PRs welcome* |
| others | — | ⬜ not started | *open — PRs welcome* |

Legend: ✅ canonical / complete and maintained · 🟡 complete but may lag behind · ⬜ started/absent.

English translations of the long-form documents live in `docs/en/` and are listed in the table in §1.
Further languages (한국어, Deutsch, Español, …) are welcome following §4.

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

1. Translate from the **canonical** `README.md` (Simplified Chinese); use `README.en.md` for
   terminology reference if needed.
2. Save as `README.<BCP-47 tag>.md` (e.g. `README.ko.md`, `README.de.md`, `README.es.md`,
   `README.zh-TW.md`). Use lowercase tags in the file name.
3. Keep code blocks, YAML keys, file paths, error codes and commands unchanged.
4. Update the language switcher line at the top of **all** README files, same order:
   `[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [繁體中文](README.zh-TW.md) | ...`
5. Add a row to the table in §2 (language, file, status, your GitHub handle).
6. Open a PR titled `docs(i18n): add <language> README`.
7. If you cannot maintain it, add `<!-- needs-translation -->` markers rather than guessing.

## 5. Keeping translations fresh

- When `README.md` (canonical) changes, the PR author must update every translation **or** add
  `<!-- needs-translation -->` at the top of the affected translated files and open an issue
  labelled `translation`.
- A monthly check (by any maintainer) compares section headings of all README files; missing
  sections get a `translation` issue.
- If a translation falls more than one minor version behind, its §2 status becomes 🟡 / ⬜.
- English long-form docs in `docs/en/` follow the same rule against their Chinese originals.

## 6. Style notes

- Keep English technical terms in parentheses where a local term is ambiguous
  (e.g. 出境（cross-border transfer）、网关（gateway）).
- Do not translate the project name, file names, config keys, or log field names.
- Use the polite/neutral register of the target language; avoid marketing tone — the project is
  deliberately conservative about its claims.
- Numbers, exit codes and error codes are never localized (`EXIT 78`, `WECHAT_GROUP_SOURCE_FORBIDDEN`).
- 繁體中文 translations should use Taiwan/Hong Kong usage (訊息、網路、資料、伺服器、預設、支援、使用者、
  帳號、程式、連線) rather than Simplified-Chinese vocabulary.

---

## 中文摘要

- **以简体中文 `README.md` 为基准**（也是 GitHub 默认展示版本）；`README.en.md` 是面向海外贡献者的参考译本，
  日文/繁体中文为社区维护译本；冲突时以简体中文为准。
- 长文档：中文原件在根目录/`docs/`，英文译本在 `docs/en/`（见 §1 对照表）。
- 任何语言的 README 都必须保留：**非商用声明**、7 条风险提示、**开发者联系方式**、
  社区贡献段落、许可证段落、"与腾讯/QQ/Telegram 无隶属关系"声明。
- 新增语言：按 §4 从简中版翻译 → `README.<语言标签>.md` → 更新**所有** README 顶部语言切换 →
  在 §2 登记 → PR 标题 `docs(i18n): add <language> README`。
- 基准版变更时，作者须同步更新译文，或加 `<!-- needs-translation -->` 并开 `translation` Issue。
