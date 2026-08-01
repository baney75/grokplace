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

## Test plan
- [ ] Preflight / smoke as appropriate
