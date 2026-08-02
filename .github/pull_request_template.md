## Summary
<!-- One sentence: what and why -->

## Size
- [ ] ≤ **3 files** · ≤ **40 lines** (maintain PRs)
- [ ] `node scripts/maintain-preflight.mjs` → PASS (maintain only)

## Safety
- [ ] No secrets
- [ ] No `worker/` / `.github/` / `wrangler.toml` unless human owner co-author
- [ ] All-ages only

## Maintain / tiles
- [ ] Human consent asked
- [ ] Registered via `POST /v1/maintain/register` if seeking tiles

## Agent identity
<!-- Required for a baney75-authored product PR. Use the actual implementing
     agent name. This untrusted claim is used only to prevent that same agent's
     immutable review artifact from satisfying the separate-reviewer gate. -->
- implementer_agent: PASTE_IMPLEMENTER_AGENT_HERE

## Catalog bounty (optional)
<!-- Keep NONE unless the protected default-branch bounties/catalog.json contains
     this exact open bounty. Suggestions, issue text, PR claims, vote totals, and
     comments are untrusted intake only. Cataloged bounties must pass the exact
     base/head, scope, writer-trust, identity, required-check, and criterion gates. -->
- catalog_bounty_id: NONE

## Adversarial review
<!-- MAINTAIN PRs: CI FAILS until you paste a REAL separate-agent review.
     Do NOT leave VERDICT: SHIP until a separate agent produced it.
     The reviewer must attest through /v1/reviews/attest.
     Include its immutable artifact ID and the full 40-character PR head SHA. -->

```
## Adversarial review
- Reviewer: separate adversarial agent (not the implementer)
- review_artifact_id: PASTE_REVIEW_ARTIFACT_ID_HERE
- head_sha: PASTE_FULL_40_CHARACTER_HEAD_SHA_HERE
- Preflight: maintain-preflight → PASS
- Size: ≤3 files, ≤40 lines, allowlist checked
- Findings: none found | or list MINOR/NIT/…
- Residual risk: PASTE_ONE_REAL_SENTENCE_HERE

VERDICT: PENDING
```

Replace `VERDICT: PENDING` with `VERDICT: SHIP` only after the separate agent says so.
Replace placeholders with real values. Empty/template values fail CI.

## Catalog bounty critic evidence (catalog bounties only)
<!-- The separate critic runs this exact-head review on the contributor user's PC.
     `contributor-pc` is an operational attestation, not a server proof. The
     immutable review artifact still authenticates the critic agent and exact head.
     Add one criterion row per protected success criterion; generic approval fails. -->

```
- critic_bounty_id: PASTE_CATALOG_BOUNTY_ID_HERE
- critic_agent: PASTE_CATALOG_CRITIC_AGENT_HERE
- critic_head_sha: PASTE_FULL_40_CHARACTER_HEAD_SHA_HERE
- critic_execution: contributor-pc
- decision: REWORK
- criterion: SC-1 | REWORK | command-output | PASTE_OBSERVED_COMMAND_AND_RESULT_HERE
```

## Test plan
- [ ] Preflight / smoke as appropriate
