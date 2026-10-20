# Governance

This document explains how decisions are made, who may merge what, and which rules are not
negotiable. It is intentionally short — small projects rot under heavy process.

---

## 1. Roles

| Role | Who | Rights |
|---|---|---|
| **Lead maintainer** | 戴亿 (DaiYi) — [@DaiYiqq](https://github.com/DaiYiqq) | Final decision on scope, releases, compliance questions; merges into `main` |
| **Maintainers** | appointed by the lead maintainer | Triage issues, review PRs, merge within their area |
| **Translators** | listed in [TRANSLATIONS.md](TRANSLATIONS.md) | Maintain one language's README; no code merge rights |
| **Contributors** | anyone | Open issues / PRs, review each other's PRs |

Adding a maintainer: sustained contributions (≥ 5 merged PRs or equivalent triage), a clean record
on the compliance invariants, and approval by the lead maintainer. Removed for inactivity (> 6
months) or for breaking a compliance invariant.

## 2. Decision rules

1. **Compliance invariants (C1–C10 in [CONTRIBUTING.md](CONTRIBUTING.md)) are constitutional.**
   They cannot be changed by a PR, by a maintainer vote, or by a config option. Only the lead
   maintainer may change them, and only after: (a) a public issue explaining why, (b) an update to
   [COMPLIANCE.md](COMPLIANCE.md), (c) new negative tests, (d) a version bump of the relevant
   notice, and (e) explicit legal review documented in the issue.
2. **Everything else is by lazy consensus.** If no maintainer objects within 7 days, a maintainer
   may merge.
3. **Disagreement** → the lead maintainer decides and records the reasoning in the issue/PR.
   "Because it is more convenient" is not a reason to weaken a gate.
4. **Scope changes** (new platforms, new message types, new deployment modes) require an RFC issue
   labelled `rfc`, open for at least 14 days.

## 3. Merge requirements (branch protection target)

- `npm run check` green (typecheck + compliance scan + tests) on the exact PR head;
- at least **1** approving review for normal changes;
- at least **2** approving reviews for changes touching any of:
  `src/compliance/**`, `src/config/schema.ts`, `src/routing/policy.ts`, `src/pipeline/forward.ts`,
  `LICENSE`, `COMPLIANCE.md`, `SECURITY.md`, `.github/workflows/**`;
- **1** approving review from the lead maintainer for any change to C1–C10;
- no merge commits of unreviewed code; squash merge preferred;
- commit subject follows `type(scope): summary` (e.g. `fix(compliance): reject trailing-dot host`).

## 4. Release process

1. Update [CHANGELOG.md](CHANGELOG.md) under a new version heading;
2. bump `version` in `package.json` (semver: MAJOR for compliance-gate changes that invalidate
   existing configurations, MINOR for features, PATCH for fixes);
3. if user-facing notices changed, bump `RISK_NOTICE_VERSION` / `noticeVersion`
   (old consent/acknowledgements then expire — this is intentional);
4. tag `vX.Y.Z`; the CI already runs on every push;
5. publish release notes that **repeat** the non-commercial restriction and the upstream risks.

## 5. Repository settings expectations

- Default branch: `main`, protected (linear history, required checks, required reviews);
- Issues enabled; Discussions optional;
- Private vulnerability reporting enabled (see [SECURITY.md](SECURITY.md));
- No paid features or sponsorships that contradict the non-commercial license;
- The repository must keep `LICENSE`, `COMPLIANCE.md`, `SECURITY.md` and all three READMEs.

## 6. Translations governance

English (`README.md`) is canonical. Translations are community-maintained best effort.
A translation may be outdated; it may **never** be less strict than the canonical version on:
non-commercial use, WeChat private-only, NapCat risks, Telegram Bot API only, cross-border risk,
and the developer contact section. See [TRANSLATIONS.md](TRANSLATIONS.md).

## 7. Conflict resolution

1. Discuss in the issue/PR; assume good faith ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)).
2. If unresolved, a maintainer summarises both positions and the lead maintainer decides.
3. Decisions are recorded in the issue; repeated re-litigation of settled compliance questions may
   be closed with a pointer to [COMPLIANCE.md](COMPLIANCE.md).

## 8. Sunset

If the lead maintainer becomes unavailable for > 12 months and no maintainer can be appointed,
the repository stays as-is (archived if necessary). Anyone may fork it under the same
non-commercial license; forks must keep the LICENSE and the compliance invariants if they claim
compatibility with this project.

---

## 中文摘要

- **角色**：主维护者（戴亿）、维护者、翻译者、贡献者。
- **决策**：合规不变量 C1–C10 为"宪法级"，任何 PR/投票/配置都不能改；只有主维护者可以，
  且必须走公开发布说明 + 更新 COMPLIANCE.md + 负向测试 + 版本号提升 + 书面法律意见。
  其余事项 7 天内无反对即可合并；分歧由主维护者裁决并记录理由。
- **合并要求**：`npm run check` 全绿；普通改动 1 个批准；触及合规/许可/CI 的改动需 2 个批准；
  触及 C1–C10 需主维护者批准；优先 squash，提交信息 `type(scope): summary`。
- **发布**：更新 CHANGELOG → 升 `package.json` 版本 → 必要时升 `riskNoticeVersion`/`noticeVersion`
  （旧同意/确认自动失效）→ 打 tag。
- **翻译**：英文为准；任何翻译在"非商用、微信仅私聊、NapCat 风险、仅 Bot API、出境风险、
  联系方式"六项上不得弱于英文版。
- **分歧**：先讨论，无法达成一致时主维护者裁决并归档理由。
