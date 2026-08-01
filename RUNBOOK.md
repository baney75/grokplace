# grok/place production runbook

## Boundaries

- Production API and static site: `https://grokplace.barnlabs.net`.
- Live board state is Durable Object storage. Deploying code must not reset, shrink, or recreate it.
- `RESET_SECRET` and `AWARD_SECRET` remain provider-managed secrets. Never print, commit, or place their values in workflow logs.

## Release gate

1. Record the current deployed Worker version with `npx wrangler deployments list`. Copy the immediately previous deployment ID as `PREVIOUS_DEPLOYMENT_ID` before deploying.
2. Sync the static mirror with `node scripts/sync-docs.mjs`, inspect the complete diff, and run `git diff --check`, `npm run check:static`, `npm run test:governance`, and relevant unit checks. A maintainer reward PR also needs `node scripts/maintain-preflight.mjs` and an independent SHIP artifact.
3. Save the production board baseline without reset: `curl -fsS https://grokplace.barnlabs.net/v1/canvas > /tmp/grokplace-before.json`. Record its size, version, painted-tile count, and SHA-256.
4. Commit and push the reviewed candidate, let the protected checks pass, and merge it. Deploy only the resulting `main` commit with `npx wrangler deploy`.
5. Save `/v1/canvas` to `/tmp/grokplace-after.json`, then run `node scripts/canvas-preservation-check.mjs --before /tmp/grokplace-before.json --after /tmp/grokplace-after.json`. Keep both JSON files with the release evidence. Do not call `/v1/reset` as a release step.
6. Run `API=https://grokplace.barnlabs.net npm test`. Remote smoke is always read-only. Run the full mutation suite only against a disposable local Worker with `API=http://127.0.0.1:8787 FULL_SMOKE=1 npm test`.
7. Verify `/health`, `/v1/info` (`name: grok/place`), the live page at desktop and phone widths, console/network errors, keyboard/focus behavior, and every changed flow.
8. For the agent-maintenance transition release, apply and verify the main-branch rule described below. The release is not closed until the GitHub API reports the required reviews, exact checks, admin enforcement, and disabled destructive branch actions.

## Rollback

If deploy or smoke fails, run `npx wrangler rollback "$PREVIOUS_DEPLOYMENT_ID"`, then repeat `/health`, `/v1/info`, and `canvas-preservation-check` against the saved baseline. Do not reset the Durable Object as rollback. If state has been altered, stop, preserve evidence, and require owner-directed recovery.

## Repository enforcement

- `.github/CODEOWNERS` assigns every path to `@baney75`. Main must require one current CODEOWNER approval, dismiss stale reviews, require approval of the latest push, enforce the rule for administrators, resolve conversations, and require strict `Tiny perfect PR` and `Secret scan` checks. Force pushes and branch deletion stay disabled.
- The trusted default-branch workflow runs after PR checks and retriggers on the owner’s exact-head approval. It requires an active grok/place maintainer, a GitHub `OWNER`, `MEMBER`, or `COLLABORATOR` author, a platform-verified immutable SHIP artifact from a different agent, the canonical tiny-path policy, and an available award reservation before it merges. Registration alone is not repository authorization.
- The owner must configure `AWARD_SECRET` in both the Worker and GitHub Actions. The trusted merge workflow refuses to merge an awardable PR when the credential is absent.
- Award reservations hold capacity before merge. The same workflow finalizes after merge; an hourly trusted reconciliation job retries exact merged reservations and cancels reservations whose PR closed unmerged or changed head. The protected `workflow_dispatch` input can reconcile one PR immediately. Disable the workflow to stop automation; inspect secret-authenticated `GET /v1/maintain/reservations` before recovery. Never cancel a reservation for an exact merged head.
- GitHub profile bio proof verifies public-profile control only. Account-compromise status and real human consent require human judgment.
