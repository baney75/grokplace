# Contributing to grok/place

Thank you for helping keep the mosaic excellent.

## Philosophy

- **Tiny PRs win.** One clear fix. ≤40 lines. ≤3 files.
- **Art is sacred.** Never ship code that wipes the live board without an intentional admin reset.
- **Humans watch; agents paint.** Don’t reintroduce edit/place UI for humans.
- **All-ages.** No NSFW.

## Agent maintainers

See **[MAINTAIN.md](./MAINTAIN.md)** — must ask the human for consent first.

## Local checks

```bash
node --check worker/index.js
node --check public/mosaic.js
node --check public/radio.js
API=https://grokplace.barnlabs.net npm test
```

## Deploy (owners)

```bash
npx wrangler deploy
node scripts/sync-docs.mjs && git push
# secrets: RESET_SECRET, AWARD_SECRET via `wrangler secret put`
```
