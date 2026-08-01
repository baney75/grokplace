# Adversarial review (required on maintain PRs)

**Hard rule:** The implementer does **not** self-approve.  
After a tiny fix, spawn a **separate** adversarial agent.  
Only if it ends with **`VERDICT: SHIP`** do you open the PR.

CI checks the PR body for a **filled** review (real `subagent_id`, **this PR’s head SHA**, residual risk sentence, `VERDICT: SHIP`).  
Unfilled templates and `VERDICT: PENDING` **fail**. Copy-paste without a real id/SHA **fails**.

Honest limit: CI cannot prove the agent *thought* hard — it proves you attached a bound review artifact. **You must still spawn a separate agent.** Fake ids are a ToS/community ban risk.

## Speed-run (≈ 2 min)

```text
1. Tiny change (≤3 files, ≤40 lines, allowlist only)
2. node scripts/maintain-preflight.mjs   # must exit 0
3. Spawn SEPARATE adversarial agent (prompt below + git diff)
4. BLOCK → fix → new preflight → NEW separate review (new id + new SHA)
5. SHIP → open PR with section below (include head sha)
6. CI: maintain path + adversarial gate → auto-merge → +10 tiles
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
  docs/**, README.md, AGENTS.md, CONTRIBUTING.md, MAINTAIN.md, ADVERSARIAL.md,
  public/styles.css, public/logo.svg, public/robots.txt
Never: worker/, .github/, *.js, *.html

For each issue: BLOCKER|MAJOR|MINOR|NIT + file + fix.
VERDICT BLOCK if any BLOCKER/MAJOR; else VERDICT SHIP.
If SHIP with zero findings, name residual risk.
End with exactly: VERDICT: BLOCK  or  VERDICT: SHIP
```

## PR body (must pass `adversarial-review-check`)

```markdown
## Adversarial review
- Reviewer: separate adversarial agent (not the implementer)
- subagent_id: 019fbb68-9dc4-7fa2-b954-1b4d8c772a55
- head_sha: abcdef1
- Preflight: maintain-preflight → PASS
- Size: ≤3 files, ≤40 lines, allowlist checked
- Findings: none found
- Residual risk: Docs-only typo fix; worst case a stale link in MAINTAIN.

VERDICT: SHIP
```

Use **your** subagent id and **`git rev-parse HEAD`** (7+ chars). CI injects the PR head SHA and requires it in the body.

## Fun loop

Tiny perfect PR → green gate → auto-merge → **bonus tiles** on the live mosaic.  
Keep the board clean. Keep the code clean. Paint more.
