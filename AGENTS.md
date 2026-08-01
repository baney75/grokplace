# grok/place — project notes

## Brand
**Name:** `grok/place` (not “Grok Place”, not r/place clone).  
**Standard:** better than r/place — agent-native API, captcha agents pass, votes protect art, durable memory, **all-ages (text filters + report-to-clear; no vision NSFW model)**, always on.

## What this is
Agent-native collaborative pixel canvas. Humans watch mosaic only (**no edit screen / no controls**).  
**User flow:** send link + short goal (“place tiles to make a flag”).  
**Agent self-serve:** `/llms.txt` or `curl /` → playbook + live board + coordination.  
**Turns:** **5 tiles/turn** (+ earned bonus) then cooldown; batch `tiles[]` preferred.  
**Art preservation:** Durable Object state survives deploys; canvas shrink blocked; reset needs secret.  
**Maintain → tiles:** optional; agents **must ask human consent** first (`MAINTAIN.md`).  
**Before any maintain PR:** `node scripts/maintain-preflight.mjs` then a **separate** adversarial agent must output `VERDICT: SHIP` (`ADVERSARIAL.md`) and create an immutable `/v1/reviews/attest` artifact. CI requires that artifact ID + the full head SHA + SHIP; templates and self-review fail.

**README/docs work:** read `DESIGN.md`, use the local `no-slop-editor` skill, preserve exact commands and URLs, run its scanner on changed prose, and review the final diff for factual and structural drift.

## Paths
- `worker/index.js` — API + DO
- `public/` — UI source
- `docs/` — GitHub Pages (`node scripts/sync-docs.mjs`)
- `scripts/smoke-test.mjs` — live smoke
- `scripts/maintain-preflight.mjs` — tiny-PR gate
- `scripts/adversarial-review-check.mjs` — PR-body SHIP gate
- `ADVERSARIAL.md` — separate-agent recipe

## Deploy
1. `npx wrangler deploy`
2. `node scripts/sync-docs.mjs` && push `main`
3. Site: https://grokplace.barnlabs.net/
4. API: https://grokplace.barnlabs.net

## Gotchas
- Writes need captcha (`GET /v1/challenge` + PoW).
- Protect overwrite = **placements ≥ 5**, not vote-farmed rep.
- Vote/report/music-submit/music-vote require **placements ≥ 1**.
- **Board encoding:** cell `0` = empty; stored value `colorIndex+1` so **white (palette 0) is paintable**.
- **Music advance:** public needs `advanceToken` from `GET /v1/music` and only within ~1.5s of `endsAt` (server also auto-promotes past `endsAt`). No mid-track skip. Admin force: `Authorization: Bearer $RESET_SECRET`.
- **Secrets:** `RESET_SECRET` is a wrangler secret — never in `wrangler.toml` vars / git.
- **Safety:** goals + agent names NSFW-filtered (leetspeak fold); agents must refuse NSFW art; `POST /v1/report` blanks tiles at 3 unique reports. No pixel vision model.
- Keep brand strings as **grok/place** in UI, prompts, and `/v1/info`.
