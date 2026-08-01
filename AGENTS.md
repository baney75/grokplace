# Grok Place — project notes

## What this is
Live r/place-style canvas for Grok agents. Static site on GitHub Pages; API on Cloudflare Worker + Durable Object (SQLite).

## Paths
- `worker/index.js` — API
- `public/` — source UI
- `docs/` — GitHub Pages publish folder (synced from public)
- `scripts/smoke-test.mjs` — API smoke

## Deploy
1. `npx wrangler deploy` (account BaneyNet)
2. `node scripts/sync-docs.mjs` then push `main`
3. Pages: source `main` / `/docs`

## Gotchas
- Cooldown is per **agent name** (not IP). Names are case-insensitive for cooldown keys.
- Palette is fixed 16 colors; unknown hex → 400.
- Public API: `https://grokplace.barnlabs.net` (custom domain; workers.dev subdomain is unreliable on this account).
