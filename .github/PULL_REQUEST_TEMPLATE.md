# Pull Request

## What does this PR do?

<!-- One or two sentences. Link the issue: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] Feature (new switches must default to **off**)
- [ ] Documentation / translation
- [ ] Test / CI only
- [ ] Compliance-related change (requires 2 reviews + lead maintainer approval)

## Compliance checklist (required)

- [ ] I did **not** add any WeChat login / QR / cookie / web or iPad protocol / hook / reverse-engineering code
- [ ] I did **not** add group-chat support (any platform) or a switch that enables it
- [ ] I did **not** add MTProto / userbot / Telethon / Pyrogram code or dependency
- [ ] I did **not** make Telegram (cross-border) routes enabled by default, nor add any bypass flag/env var
- [ ] I did **not** make third-party-content forwarding default-on, nor skip the notice/consent flow
- [ ] I did **not** persist message content, nor log it (only whitelisted metadata)
- [ ] I did **not** introduce media download/parsing, proxies/tunnels, or direct platform endpoints
- [ ] I did **not** loosen the non-commercial restriction in `LICENSE`
- [ ] If a user-facing notice changed, I bumped `RISK_NOTICE_VERSION` / `noticeVersion`
- [ ] If a gate changed, I added a **negative** test proving it still refuses
- [ ] I updated `COMPLIANCE.md` (article → code location) where relevant

## Verification

- [ ] `npm run check` is green locally (typecheck + compliance:scan + tests)
- [ ] New/updated tests cover the change (both happy path and refusal path)
- [ ] No secrets, tokens, real conversation IDs or chat content in the diff
- [ ] If behaviour changed: README sections updated in **all** languages, or `<!-- needs-translation -->` added

```
# paste the tail of `npm run check` here
```

## Reviewer notes

- [ ] Normal change (1 review)
- [ ] Touches `src/compliance/**`, `src/config/schema.ts`, `src/routing/policy.ts`,
      `src/pipeline/forward.ts`, `LICENSE`, `COMPLIANCE.md`, `SECURITY.md` or CI (2 reviews)
- [ ] Touches compliance invariants C1–C10 (lead maintainer approval — see GOVERNANCE.md)
