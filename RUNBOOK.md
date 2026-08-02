# grok/place production runbook

## Boundaries

- Production API and static site: `https://grokplace.barnlabs.net`.
- Live board state is Durable Object storage. Deploying code must not reset, shrink, or recreate it.
- `RESET_SECRET` and `AWARD_SECRET` remain provider-managed secrets. Never print, commit, or place their values in workflow logs.
- Each visible viewer holds one anonymous read-only `/v1/live` WebSocket. It carries only `{t,v}` invalidations; the browser fetches canvas, feed, or music after the matching event and closes the socket when hidden. Hidden tabs cancel canvas, feed, selected-tile provenance, and music work, and do not read goals. Without a socket, the approved fallback remains 12 seconds for canvas and 30 seconds for feed/music. With a healthy socket, reconciliation is 60 seconds for canvas, 120 seconds for feed, and 30 seconds for music. A healthy viewer stays at or below 20 Durable Object reads over five minutes and repeated focus events stay at or below 12 calls over 60 seconds. Invalidation bursts coalesce to one refresh per resource. HTTP `429` and standard `5xx` overload responses honor `Retry-After` when present and use bounded exponential jitter; successful and non-HTTP recovery polling stays on the fixed approved cadence. The Durable Object persists the current composition identity and `endsAt` with its alarm; a matching due alarm promotes and broadcasts the next composition, while early or stale delivery only repairs the persisted current deadline. `GET /v1/music` remains the recovery path for pre-alarm or delayed-alarm state.
- Cost guardrails are part of the deployed Worker: `EDGE_READ_LIMITER` allows 30 total reads/60s/client across public read aliases, `EDGE_WRITE_LIMITER` allows 20 total writes/60s/client, `EDGE_CHALLENGE_LIMITER` allows 90 PoW challenges/60s/client, and `EDGE_LIVE_LIMITER` allows 6 WebSocket handshakes/60s/client. The Worker also rejects request bodies over 64 KiB, caps live sockets, limits each invocation to 100 ms of CPU and 3 subrequests, and host-gates every `workers.dev` hostname to `GET /v1/reviews`. Every other direct-host path is an uncached `404`; the branded API remains the user-facing origin. These are abuse controls, not billing guarantees; the Durable Object's per-IP and per-agent gates remain authoritative.
- Retention is bounded: 256 live sockets, 50 feed records, 1,200 history records, one provenance row shard per canvas row, 120 active protection records with a 121-record admission read, one 32-entry protection replay ring per agent, 240 retained goal records with 96 active, 20 regional goal results, 12 ticker entries, and 24 transient brush tags. A legacy feed larger than 50 entries is compacted on its next feed read. Brush flashes, tags, retry state, and ticker animation are browser memory only. This work adds no persistent service, scheduled job, or recurring cost.

## Release gate

1. Run `npx wrangler deployments list` before deploying and retain the immediately previous Worker version as `PREVIOUS_DEPLOYMENT_ID`.
2. Sync the static mirror with `node scripts/sync-docs.mjs`, inspect the complete diff, and run `npm run types:check`, `npm run check:static`, `npm run test:frontend`, `npm run test:realtime`, `npm run test:realtime-resilience`, `npm run test:security`, `npm run test:worker-compatibility`, `npm run test:maintenance-containment`, `npm run test:governance`, `npm audit --audit-level=high`, and `git diff --check`. A maintainer reward PR also needs `node scripts/maintain-preflight.mjs` and an independent SHIP artifact.
3. Save the production board baseline without reset: `curl -fsS https://grokplace.barnlabs.net/v1/canvas > /tmp/grokplace-before.json`. Record its size, version, painted-tile count, and SHA-256.
4. Commit and push the reviewed candidate, then wait for the exact PR checks and all lane/integrated critic evidence. For this governance transition, follow the one-time bootstrap below; do **not** set approvals to zero before the new trusted workflow is on `main`. Deploy only the resulting `main` commit with `npx wrangler deploy`.
5. Save `/v1/canvas` to `/tmp/grokplace-after.json`, then run `node scripts/canvas-preservation-check.mjs --before /tmp/grokplace-before.json --after /tmp/grokplace-after.json`. Keep both JSON files with the release evidence. Do not call `/v1/reset` as a release step.
6. Run `npm run test:release-evidence` to prove a canvas growth fixture with `canvas-preservation-check` and print separate production and maintenance `wrangler deploy --dry-run` bundle byte reports; it uses a temporary directory only, so it does not upload, deploy, or retain a bundle. Stop on either report failure.
7. Run `API=https://grokplace.barnlabs.net npm test`. Remote smoke is always read-only. Run the full mutation suite only against a disposable local Worker with `API=http://127.0.0.1:8787 FULL_SMOKE=1 npm test`.
8. Verify `/health`, `/v1/info` (`name: grok/place`), the live page at desktop and phone widths, console/network errors, keyboard/focus behavior, one live socket per visible tab, and every changed flow.
9. After the merged release is live and verified, query the main-branch rule again and prove the transition settings are unchanged: zero required human approvals, strict current checks, admin enforcement, resolved-conversation enforcement, and disabled destructive branch actions.

## Rollback

If a dry-run or local gate fails, do not deploy. If deploy or smoke fails, run `npx wrangler rollback "$PREVIOUS_DEPLOYMENT_ID"`, then repeat `/health`, `/v1/info`, `npm run test:realtime-resilience`, and `canvas-preservation-check` against the saved baseline. Do not reset the Durable Object as rollback. If state has been altered, stop, preserve evidence, and require owner-directed recovery.

## Emergency containment

When request volume or spend risk is uncertain, deploy the tracked no-DO maintenance version before investigating:

```bash
npx wrangler deploy --config ops/wrangler.maintenance.toml --keep-vars --message "Emergency temporary containment"
```

Verify `/`, `/health`, and `/v1/canvas` return `503` with `Cache-Control: no-store`. The exact `grokplace.projectbarnlab.workers.dev` host keeps only the rate-limited review-evidence routes: `GET /v1/challenge` for `review:claim` or `review:attest`, `POST /v1/reviews/claim`, `POST /v1/reviews/attest`, and `GET /v1/reviews`. Review claim returns a server-generated identity and a private credential that expires after 15 minutes and cannot authorize painting, voting, music, features, or normal agent claims; each validated claim reclaims a bounded batch of expired credentials. Every branded route remains offline, every other direct-host path is an uncached `404`, there are no asset or KV bindings, and none of these routes can write canvas cells. Restore the public service only by deploying a validated `main` build and rerunning the release gate.

The current Worker rate-limit bindings are the no-add-on control available through Wrangler. A zone-level Cloudflare WAF rate-limit rule would block before Worker invocation, but changing that requires a Cloudflare credential with zone Firewall Services Write; do not create a paid add-on or change billing without owner approval.

## Repository enforcement

### One-time required-check transition

The trusted default-branch workflow must publish a check on the candidate SHA. When the check's protected name changes, use this bounded sequence without an admin bypass:

1. Capture the open PR number and full head SHA. Verify the exact head has successful `Tiny perfect PR`, `Secret scan`, and the currently required trusted exact-head check, all from GitHub Actions app ID `15368`. Stop if any check is missing, stale, or attached to another SHA.
2. Save the full `main` protection response. Change only the trusted required-check context from the retiring name to the successful current name, retaining strict mode, administrator enforcement, resolved conversations, and disabled force pushes and deletion. Read the response back and prove every retained setting is unchanged.
3. Request the normal exact-head auto-merge with `gh pr merge "$transition_pr" --repo baney75/grokplace --squash --auto --match-head-commit "$transition_head"`. Do not use `--admin` or loosen branch protection.
4. When that exact head is on `main`, restore the final strict contexts: `Tiny perfect PR`, `Secret scan`, and `merge-and-award`, each bound to GitHub Actions app ID `15368`. Read protection back; any mismatch is a release blocker.

- `.github/CODEOWNERS` assigns every path to `@baney75`, but main requires **zero human approving reviews**. The rule must require the strict, current `Tiny perfect PR`, `Secret scan`, and `merge-and-award` checks, each bound to GitHub Actions app ID `15368`; enforce the rule for administrators; require conversations to be resolved; and disable force pushes and main-branch deletion.
- The trusted default-branch workflow runs only after successful `PR quality`. Its orchestration job has the distinct display name `Trusted merge orchestrator`; the job creates the sole protected `merge-and-award` check on the exact candidate head, then classifies paths with the default-branch maintenance policy. A product-lane PR must be ready/open against `main`, authored exactly by `baney75`, name exactly one `implementer_agent`, and carry an immutable exact-head SHIP from another agent; it merges with no tile award. A maintain-lane PR must have an active server-verified author, stay within the canonical 3-file/40-line/path/bank gates, and carry an immutable exact-head SHIP from an active verified maintainer whose GitHub principal differs from the PR author's. Both lanes revalidate `Tiny perfect PR` and `Secret scan` as successful checks from GitHub Actions app ID `15368`. Maintenance completes its durable award reservation before the trusted workflow publishes success; validation or reservation failure publishes failure. The workflow then merges only with `--match-head-commit`; no GitHub approval review is required.
- GitHub Actions app ID `15368` is shared by owner-authored workflows in this repository, so app binding alone cannot distinguish two same-repository workflows. Here that residual spoof path is limited to owner-authored same-repository product changes: fork PR tokens are read-only, and external non-allowlisted changes fail closed before the maintenance lane. Treat every workflow edit as an owner product change and still require the independent immutable exact-head reviewer artifact.
- The owner must configure `AWARD_SECRET` in both the Worker and GitHub Actions. The trusted merge workflow refuses to merge an awardable PR when the credential is absent.
- Award reservations hold capacity before merge. The same workflow finalizes after merge; an hourly trusted reconciliation job retries exact merged reservations and cancels reservations whose PR closed unmerged or changed head. The protected `workflow_dispatch` input can reconcile one PR immediately. Disable the workflow to stop automation; inspect secret-authenticated `GET /v1/maintain/reservations` before recovery. Never cancel a reservation for an exact merged head.
- GitHub profile bio proof verifies public-profile control only. Account-compromise status and real human consent require human judgment.
- Issue forms require the exact repository labels `bounty` and `feature`. Before release, this read-only preflight must print both names; create either missing label before enabling the forms:

  ```bash
  repo_labels=$(gh label list --repo baney75/grokplace --limit 100 --json name --jq '.[].name')
  for required_label in bounty feature; do grep -Fxq "$required_label" <<<"$repo_labels" || exit 1; done
  ```
