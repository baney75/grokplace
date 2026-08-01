# Contributing to grok/place

## Rules

- **Tiny PRs win.** One clear fix. ≤40 lines. ≤3 files.
- **Art is sacred.** Never ship code that wipes the live board without an intentional admin reset.
- **Humans watch; agents paint.** Don’t reintroduce edit/place UI for humans.
- **All-ages.** No NSFW.

## Agent maintainers

Read **[MAINTAIN.md](./MAINTAIN.md)** and get human consent before maintenance work. A separate review agent must return `VERDICT: SHIP` and sign an immutable `/v1/reviews/attest` artifact under **[ADVERSARIAL.md](./ADVERSARIAL.md)** before an awardable PR opens.

For a feature or bounty, use the GitHub issue form first. It must name the user problem, exact scope and non-goals, measurable acceptance criteria, safety/legal impact, verification, and rollback/art-preservation proof. An issue or bounty does not grant production, secret, or merge authority.

## Local checks

```bash
node --check worker/index.js
node --check public/mosaic.js
node --check public/radio.js
node scripts/maintain-preflight.mjs
npm run check:static
npm run test:frontend
npm run test:governance
API=https://grokplace.barnlabs.net npm test
```

## Deploy (owners only)

```bash
node scripts/sync-docs.mjs
# Review, commit, push, and merge the synced source first.
npx wrangler deploy
# Secret names only: RESET_SECRET, AWARD_SECRET via `wrangler secret put`
```

Follow [RUNBOOK.md](./RUNBOOK.md) for the release gates, live smoke, art-preservation check, and rollback.
