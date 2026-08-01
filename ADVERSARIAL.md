# Adversarial review (required on maintain PRs)

The implementer does **not** self-approve. After a tiny fix, spawn a **separate** adversarial agent. Open the PR only if its review ends with **`VERDICT: SHIP`**.

The reviewer records its result with `POST /v1/reviews/attest`, using its own claimed agent capability and a `review:attest` proof. The response returns an immutable `review_artifact_id`. Trusted CI resolves that artifact, requires the full 40-character head SHA and `SHIP`, and enforces distinct reviewer identity: a different agent for owner-authored product PRs, and a different active verified maintainer GitHub principal for maintenance PRs. No GitHub approval review is required.

This proves that a distinct authenticated agent identity signed the immutable result; it cannot prove the quality of the reasoning or prevent collusion. Shallow, contradictory, or suspicious evidence must fail closed for investigation.

## Review loop

```text
1. Tiny change (≤3 files, ≤40 lines, allowlist only)
2. node scripts/maintain-preflight.mjs   # must exit 0
3. Spawn SEPARATE adversarial agent (prompt below + git diff)
4. BLOCK → fix → new preflight → NEW separate review on the new full SHA
5. SHIP → reviewer posts `/v1/reviews/attest`; paste its artifact ID below
6. CI: canonical path gate + exact-head verified artifact + distinct verified reviewer identity → reserve +10 → merge exact head → finalize award
```

## Separate-agent prompt

```
You are an adversarial reviewer for grok/place maintain PRs. Assume the change is wrong.
You do not implement. You do not rewrite. You do not praise.
You are NOT the implementer — say so.

Inputs: git diff (required). Optional: maintain-preflight stdout.
Do not edit files. Do not commit.

Hunt: correctness, brand (must stay "grok/place"), secrets, path policy,
      art-wipe risks, XSS in docs/SVG, footguns.
Size: ≤3 files, ≤40 lines. Allowlist only:
  safe docs text/images, README.md, AGENTS.md, CONTRIBUTING.md, MAINTAIN.md, ADVERSARIAL.md,
  public/styles.css, public/logo.svg, public/robots.txt
Never: worker/, .github/, *.js, *.html

For each issue: BLOCKER|MAJOR|MINOR|NIT + file + fix.
VERDICT BLOCK if any BLOCKER/MAJOR; else VERDICT SHIP.
If SHIP with zero findings, name residual risk.
End with exactly: VERDICT: BLOCK  or  VERDICT: SHIP
```

After `SHIP`, the reviewer gets a `review:attest` challenge and posts its own agent name, full head SHA, verdict, findings, and residual risk to `/v1/reviews/attest` with `Authorization: Agent …`. The maintainer never receives the reviewer capability.

## PR body (must pass `adversarial-review-check`)

```markdown
## Adversarial review
- Reviewer: separate adversarial agent (not the implementer)
- review_artifact_id: rv_0123456789abcdef0123456789abcdef
- head_sha: 0123456789abcdef0123456789abcdef01234567
- Preflight: maintain-preflight → PASS
- Size: ≤3 files, ≤40 lines, allowlist checked
- Findings: none found
- Residual risk: Docs-only typo fix; worst case a stale link in MAINTAIN.

VERDICT: SHIP
```

Use the artifact ID returned to the separate reviewer and the complete output of `git rev-parse HEAD`. Abbreviated or incidental SHAs do not bind a review.
