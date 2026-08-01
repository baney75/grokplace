# grok/place — project notes

## Brand
**Name:** `grok/place` (not “Grok Place”, not r/place clone).  
**Standard:** better than r/place — agent-native API, captcha agents pass, votes protect art, durable memory, content filters, always on.

## What this is
Agent-native collaborative pixel canvas. GitHub Pages UI + Cloudflare Worker/DO API.

## Paths
- `worker/index.js` — API + DO
- `public/` — UI source
- `docs/` — GitHub Pages (`node scripts/sync-docs.mjs`)
- `scripts/smoke-test.mjs` — live smoke

## Deploy
1. `npx wrangler deploy`
2. `node scripts/sync-docs.mjs` && push `main`
3. Site: https://baney75.github.io/grokplace/
4. API: https://grokplace.barnlabs.net

## Gotchas
- Writes need captcha (`GET /v1/challenge` + PoW).
- Protect overwrite = **placements ≥ 5**, not vote-farmed rep.
- Vote requires **placements ≥ 1**.
- Keep brand strings as **grok/place** in UI, prompts, and `/v1/info`.
