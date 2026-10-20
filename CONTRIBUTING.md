# Contributing to im-forwarder

Thanks for helping. This project is **community-maintained**, but it has a hard constraint that
takes precedence over features: **compliance invariants may never be weakened.**
Read this file fully before opening a PR.

- [中文要点](#中文要点) is at the bottom.
- Questions? [CONTACT.md](CONTACT.md). Security issues? [SECURITY.md](SECURITY.md).
- Governance (who can merge what): [GOVERNANCE.md](GOVERNANCE.md).

---

## 1. Ground rules

1. **Non-commercial only.** By contributing you agree your contribution is licensed under
   MIT + Commons Clause ([LICENSE](LICENSE)). Do not contribute code intended for paid
   forwarding, paid hosting or resale.
2. **No platform SDKs.** The only allowed runtime dependencies are `ws`, `yaml`, `zod`
   (dev: `@types/node`, `@types/ws`, `tsx`, `typescript`). `npm run compliance:scan` enforces an
   exact allow-list; PRs adding dependencies need a written justification in the PR body.
3. **No credentials, ever.** Never commit cookies, `bot_token`, QR tickets, MTProto `api_hash`/
   `session`, tokens, or real conversation IDs. Use placeholders.
4. **Be precise about claims.** Do not describe the project as "compliant", "certified" or
   "legal". It is a technical control, not a compliance guarantee.

## 2. Compliance invariants (a PR must not break these)

Any PR that weakens one of the following is **rejected**, regardless of tests passing:

| # | Invariant | Where |
|---|---|---|
| C1 | WeChat only via the gateway's official iLink(ClawBot) channel; no login/QR/cookie/web/iPad/hook/RE code | `src/gateway/contract.ts`, `src/config/load.ts` |
| C2 | No group-chat support on **any** platform; no config switch may enable it | `src/compliance/gates.ts`, `src/routing/policy.ts` |
| C3 | Telegram only via official Bot API; no MTProto/userbot/Telethon/Pyrogram paths | dependencies + `scripts/compliance-scan.mjs` |
| C4 | Telegram (cross-border) routes default off; four confirmations + notice version required; **no `--force`** | `src/config/schema.ts`, `src/compliance/preflight.ts` |
| C5 | Third-party content default forbidden; notice-then-consent, per-route consent, recallable | `src/compliance/consent*.ts`, `src/pipeline/forward.ts` |
| C6 | No message-content persistence and no content in logs | `src/observability/logger.ts` |
| C7 | The service never calls platform endpoints directly (gateway only) | `src/compliance/gates.ts` |
| C8 | Media is skipped with an explicit notice; never downloaded/decoded | `src/pipeline/transform.ts` |
| C9 | No proxy/tunnel/circumvention code or configuration | repository-wide |
| C10 | The non-commercial restriction in `LICENSE` must not be loosened | `LICENSE` |

If your change touches C1–C10 (directly or indirectly), the PR **must** also:

1. update [COMPLIANCE.md](COMPLIANCE.md) (article → code location table);
2. bump `RISK_NOTICE_VERSION` / `noticeVersion` in `src/config/schema.ts` when user-facing
   notices change (old acknowledgements must expire);
3. add or update tests — including a **negative** test proving the gate still refuses;
4. be reviewed by a second maintainer (see [GOVERNANCE.md](GOVERNANCE.md)).

## 3. Workflow

```powershell
git clone https://github.com/DaiYiqq/im-forwarder.git
cd im-forwarder
npm ci

# create a branch
git switch -c fix/short-description

# ... make changes ...

npm run check     # required: typecheck + compliance:scan + tests (must be green)
git commit -m "fix(compliance): describe the change"
git push -u origin fix/short-description
# open a PR using the template
```

- Keep PRs focused: one logical change per PR.
- Do not reformat untouched files; do not bump unrelated versions.
- `npm run check` must be green **before** review starts.
- Squash-merge is preferred; the PR title becomes the commit subject.

## 4. Code conventions

- TypeScript strict mode; no `any` in new code (`unknown` + narrowing is preferred).
- Comments and user-facing notices in **Chinese** (they are delivered to Chinese-speaking users);
  identifiers, commit subjects and PR titles in English.
- Logs go through `src/observability/logger.ts` only. `console.log` in `src/` fails CI.
- Never log or include in error codes: message content, conversation IDs, response bodies.
- Every new gate gets a **negative** test (the refusal path), not only a happy-path test.
- Prefer adding a config flag defaulting to **off** over changing an existing default.

## 5. Docs & translations

- Simplified Chinese README is canonical: [README.md](README.md). English: [README.en.md](README.en.md).
  日本語: [README.ja.md](README.ja.md). 繁體中文: [README.zh-TW.md](README.zh-TW.md).
  Long-form English docs: `docs/en/`.
- Anything that changes behaviour must update the README section affected **in all languages**
  (or add `<!-- needs-translation -->` and open a translation issue).
- All READMEs must keep the non-commercial warning and the developer contact table.
- See [TRANSLATIONS.md](TRANSLATIONS.md) for how to add a new language.

## 6. Reporting bugs / requesting features

Use the issue templates. For security or abuse, follow [SECURITY.md](SECURITY.md).
Never paste real chat content or credentials into an issue.

---

## 中文要点

1. **非商用**：贡献即视为同意以 MIT + Commons Clause 授权；不要提交面向收费转发/付费托管的代码。
2. **依赖白名单**：运行时只允许 `ws/yaml/zod`；新增依赖需在 PR 中说明理由，`npm run compliance:scan` 会拦截。
3. **合规不变量 C1–C10 不可削弱**（见上表）：群聊、微信登录代码、userbot、默认放开出境、
   正文落盘/入日志、直连平台域名、代理规避、媒体解析、放开非商业限制 —— 触碰任何一条直接拒绝。
4. 触碰合规逻辑的 PR 必须：更新 `COMPLIANCE.md`、必要时提升 `riskNoticeVersion`/`noticeVersion`、
   补**负向测试**、并由第二位维护者评审。
5. 合并前 `npm run check` 必须全绿；日志一律走 `Logger`，禁止 `console.log`。
6. 行为变更需同步更新全部语言 README（或标记 `<!-- needs-translation -->` 并开翻译 Issue），
   且所有语言 README 都必须保留"非商用声明"与"开发者联系方式"。
7. Bug 用 Issue 模板提；安全问题按 [SECURITY.md](SECURITY.md) 私下报告；**不要在 Issue 里贴聊天内容或凭据**。
8. 提交信息用英文（如 `fix(compliance): ...`），注释与用户可见文案用中文。
