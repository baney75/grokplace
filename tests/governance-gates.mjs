#!/usr/bin/env node
/** Minimal regression tests for the offline maintenance gates. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isMaintainAwardPath } from "../shared/maintain-policy.js";
import { publicMaintainer } from "../worker/index.js";

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "grokplace-governance-"));
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function runBody(name, body, sha, expected) {
  const file = join(temp, `${name}.md`);
  writeFileSync(file, body);
  const out = spawnSync(process.execPath, ["scripts/adversarial-review-check.mjs", "--body-file", file, "--head-sha", sha], {
    cwd: root,
    encoding: "utf8",
  });
  check(name, out.status === expected, `${out.stdout}${out.stderr}`.trim());
}

function runArtifact(name, artifact, expected) {
  const file = join(temp, `${name}.json`);
  writeFileSync(file, JSON.stringify(artifact));
  const out = spawnSync(process.execPath, ["scripts/review-artifact-check.mjs", "--mode", "product-owner", "--file", file, "--artifact", "rv_11111111111111111111111111111111", "--head", sha, "--implementer-agent", "author-agent"], { cwd: root, encoding: "utf8" });
  check(name, out.status === expected, `${out.stdout}${out.stderr}`.trim());
}

function runSecret(name, path, addedLine, expected) {
  const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${addedLine}\n`;
  const out = spawnSync(process.execPath, ["scripts/credential-diff-scan.mjs"], { cwd: root, encoding: "utf8", input: patch });
  check(name, out.status === expected, `${out.stdout}${out.stderr}`.trim());
}

const sha = "0123456789abcdef0123456789abcdef01234567";

const qualityWorkflow = readFileSync(join(root, ".github/workflows/pr-quality.yml"), "utf8");
const mergeWorkflow = readFileSync(join(root, ".github/workflows/auto-merge-tiny.yml"), "utf8");
const codeowners = readFileSync(join(root, ".github/CODEOWNERS"), "utf8");
const bountyForm = readFileSync(join(root, ".github/ISSUE_TEMPLATE/bounty.yml"), "utf8");
const featureForm = readFileSync(join(root, ".github/ISSUE_TEMPLATE/feature.yml"), "utf8");
const prTemplate = readFileSync(join(root, ".github/pull_request_template.md"), "utf8");
const maintainGuide = readFileSync(join(root, "MAINTAIN.md"), "utf8");
const adversarialGuide = readFileSync(join(root, "ADVERSARIAL.md"), "utf8");
const runbook = readFileSync(join(root, "RUNBOOK.md"), "utf8");
const reviewArtifactCheck = readFileSync(join(root, "scripts/review-artifact-check.mjs"), "utf8");
const workerSource = readFileSync(join(root, "worker/index.js"), "utf8");
const wranglerConfig = readFileSync(join(root, "wrangler.toml"), "utf8");
check("Worker caching stays enabled behind explicit response policies", /\[cache\]\s+enabled\s*=\s*true/.test(wranglerConfig));
check("Worker execution has bounded CPU and subrequests", /\[limits\]\s+cpu_ms\s*=\s*100\s+subrequests\s*=\s*3/.test(wranglerConfig));
check("privileged workflow uses workflow_run", /workflow_run:/.test(mergeWorkflow) && !/pull_request_target:/.test(mergeWorkflow));
check("trusted merge is triggered only by successful PR quality", /workflows:\s*\[PR quality\]/.test(mergeWorkflow) && /workflow_run\.conclusion == 'success'/.test(mergeWorkflow) && /workflow_run\.event == 'pull_request'/.test(mergeWorkflow));
check("obsolete human approval signal is removed", !existsSync(join(root, ".github/workflows/maintain-approval-signal.yml")) && !/Maintain approval signal|pull_request_review/.test(mergeWorkflow));
check("durable reservations have scheduled and manual reconciliation", /schedule:/.test(mergeWorkflow) && /workflow_dispatch:/.test(mergeWorkflow) && /reconcile-reservations:/.test(mergeWorkflow));
check("privileged workflow checks out the default branch", /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/.test(mergeWorkflow));
check("untrusted PR workflow receives no award secret", !/secrets\.AWARD_SECRET/.test(qualityWorkflow));
check("PR quality runs reviewer-identity regressions", /npm run test:review-identity/.test(qualityWorkflow));
check("PR quality runs realtime regressions after reviewer identity", qualityWorkflow.indexOf("npm run test:review-identity") < qualityWorkflow.indexOf("npm run test:realtime"));
check("secret-path guard permits deletion of a forbidden legacy file", /git diff --name-status/.test(qualityWorkflow) && /\$1 !~ \/\^D\//.test(qualityWorkflow) && /files-present-after-pr\.txt/.test(qualityWorkflow));
check("trusted PR workflow runs the path-aware secret diff scanner", /git diff[^\n]+\| node scripts\/credential-diff-scan\.mjs/.test(qualityWorkflow));
check("trusted merge workflow coalesces stale runs per PR", /group:\s*trusted-pr-merge-/.test(mergeWorkflow) && /github\.event_name == 'workflow_run'/.test(mergeWorkflow) && /format\('run-\{0\}', github\.run_id\)/.test(mergeWorkflow) && /cancel-in-progress:\s*true/.test(mergeWorkflow));
check("merge refuses a bank that cannot accept the full award", /\.bank\.bonusTiles >= 0 and \.bank\.bonusTiles <= 190/.test(mergeWorkflow));
check("trusted workflow resolves the immutable review artifact", /review-artifact/.test(mergeWorkflow) && /review-artifact-check\.mjs/.test(mergeWorkflow));
check(
  "trusted workflow separates the read-only review mirror from live maintainer state",
  /REVIEW_API:\s*https:\/\/grokplace\.projectbarnlab\.workers\.dev/.test(mergeWorkflow) &&
    /APP_API:\s*https:\/\/grokplace\.barnlabs\.net/.test(mergeWorkflow) &&
    /"\$REVIEW_API\/v1\/reviews"/.test(mergeWorkflow) &&
    /"\$APP_API\/v1\/maintainers"/.test(mergeWorkflow) &&
    /"\$APP_API\/v1\/bank"/.test(mergeWorkflow) &&
    !/"\$REVIEW_API\/v1\/(?:maintainers|bank)"/.test(mergeWorkflow)
);
check("owner-authored PRs always enter product lane before path classification", /if \[ "\$AUTHOR" = "baney75" \]; then\s+LANE=product\s+elif jq -r '\.\[\]\.filename' \/tmp\/files\.json \| node scripts\/maintain-path-check\.mjs[\s\S]*then\s+LANE=maintain/.test(mergeWorkflow));
check("non-owner PRs fail closed outside the maintain allowlist", /Non-owner PRs are eligible only for the allowlisted maintenance lane\."\s+exit 1/.test(mergeWorkflow) && /jq -r '\.\[\]\.filename' \/tmp\/files\.json \| node scripts\/maintain-path-check\.mjs/.test(mergeWorkflow));
check("product lane is owner-authored and names one real implementer agent", /\[ "\$AUTHOR" = "baney75" \]/.test(mergeWorkflow) && /exactly one implementer_agent field/.test(mergeWorkflow) && /PASTE_IMPLEMENTER_AGENT_HERE/.test(mergeWorkflow) && /--mode product-owner[\s\S]*--implementer-agent "\$IMPLEMENTER_AGENT"/.test(mergeWorkflow));
check("maintain lane requires one active server maintainer and a distinct verified maintainer reviewer", /\.status == "active"\)\]\s*\| length == 1/.test(mergeWorkflow) && /--mode maintainer[\s\S]*--author-github "\$AUTHOR" --require-verified-maintainer/.test(mergeWorkflow) && /review\.reviewerGithub\.toLowerCase\(\) === authorGithub\.toLowerCase\(\)/.test(reviewArtifactCheck));
check("both lanes require exact successful GitHub Actions checks", /\.app\.id == 15368[\s\S]*sort == \["Secret scan", "Tiny perfect PR"\]/.test(mergeWorkflow));
check("trusted merge requires no GitHub approval review", !/pulls\/\$PR\/reviews|\.state == "APPROVED"/.test(mergeWorkflow));
const pendingCheck = mergeWorkflow.indexOf('-f status="in_progress"');
const validateCandidate = mergeWorkflow.indexOf("Validate exact head, lane, reviewer identity, bounty, and checks");
const reserveAward = mergeWorkflow.indexOf('phase:"reserve"');
const successCheck = mergeWorkflow.indexOf('-f conclusion="success"');
const mergeExactHead = mergeWorkflow.indexOf('gh pr merge "$PR"');
check("trusted check lifecycle orders pending, validation, reservation, success, and merge", pendingCheck >= 0 && pendingCheck < validateCandidate && validateCandidate < reserveAward && reserveAward < successCheck && successCheck < mergeExactHead);
check("award is reserved before merge and finalized after", reserveAward < mergeExactHead && mergeExactHead < mergeWorkflow.indexOf('phase:"finalize"'));
check("only the maintain lane reserves and finalizes an award", /Reserve the exact maintain award before merge[\s\S]*if: steps\.validation\.outputs\.lane == 'maintain'/.test(mergeWorkflow) && /Finalize the reserved maintain award[\s\S]*if: steps\.validation\.outputs\.lane == 'maintain'/.test(mergeWorkflow));
check("trusted workflow has Checks write authority", /merge-and-award:[\s\S]*permissions:[\s\S]*checks: write/.test(mergeWorkflow));
check("pending trusted check is created on the full candidate head", /CHECK_ID=\$\(gh api --method POST "repos\/\$REPO\/check-runs"[\s\S]*-f name="Trusted agent review" -f head_sha="\$HEAD" -f status="in_progress"/.test(mergeWorkflow) && /\[\[ "\$HEAD" =~ \^\[a-f0-9\]\{40\}\$ \]\]/.test(mergeWorkflow));
check("trusted success binds exact check ID, head, app, and current PR head", /CURRENT=\$\(gh api "repos\/\$REPO\/pulls\/\$PR" --jq '\.head\.sha'\)[\s\S]*repos\/\$REPO\/check-runs\/\$CHECK_ID[\s\S]*\.head_sha == \$head and \.name == "Trusted agent review" and \.app\.id == 15368 and \.status == "in_progress"[\s\S]*conclusion="success"/.test(mergeWorkflow));
check("failed validation always publishes exact-head trusted failure", /Publish failed trusted agent review[\s\S]*if: \$\{\{ always\(\)[\s\S]*steps\.trusted_success\.outcome != 'success'[\s\S]*\.head_sha == \$head and \.name == "Trusted agent review" and \.app\.id == 15368[\s\S]*conclusion="failure"/.test(mergeWorkflow));
check("untrusted PR workflow cannot publish the trusted review check", !/Trusted agent review/.test(qualityWorkflow));
check("merge atomically requires the reserved head SHA", /gh pr merge "\$PR" --repo "\$REPO" --squash --delete-branch --match-head-commit "\$HEAD"/.test(mergeWorkflow));
check("trusted merge enables exact-head GitHub auto-merge with a bounded observation", /gh pr merge "\$PR" --repo "\$REPO" --squash --delete-branch --match-head-commit "\$HEAD" --auto[\s\S]*for attempt in \{1\.\.20\}[\s\S]*sleep 3[\s\S]*echo "merged=false"/.test(mergeWorkflow));
check("completed auto-merges report the exact successful observation", /if jq -e --arg head "\$HEAD" '[\s\S]*echo "merged=true" >> "\$GITHUB_OUTPUT"[\s\S]*exit 0/.test(mergeWorkflow));
check("queued maintenance merges defer award finalization to durable reconciliation", /Exact-head auto-merge is enabled; durable reconciliation will finalize a maintenance award[\s\S]*Auto-merge is still pending; reconciliation will finalize this maintenance award/.test(mergeWorkflow));
check("maintenance awards finalize only after observed merge or durable reconciliation", /\[ "\$\{\{ steps\.merge\.outputs\.merged \}\}" = "true" \][\s\S]*phase:"finalize"[\s\S]*reconcile-reservations[\s\S]*phase:"finalize"/.test(mergeWorkflow));
check("bounty creation has no circular owner-comment field", !/\bid:\s*owner\b/.test(bountyForm) && /After creation[\s\S]*BOUNTY APPROVED/.test(bountyForm));
check("PR template makes the optional bounty pair explicit", /- bounty_issue:\s*NONE/.test(prTemplate) && /- bounty_approval_comment:\s*NONE/.test(prTemplate));
check("PR template exposes exactly one implementer-agent field", (prTemplate.match(/^- implementer_agent:/gm) || []).length === 1 && /PASTE_IMPLEMENTER_AGENT_HERE/.test(prTemplate));
check("ordinary maintenance accepts only the explicit NONE bounty pair", /\[ "\$BOUNTY_ISSUE" = "NONE" \] && \[ "\$BOUNTY_COMMENT" = "NONE" \]/.test(mergeWorkflow));
check("claimed bounty metadata fails closed unless both fields are present", /elif \[ "\$BOUNTY_ISSUE" = "NONE" \] \|\| \[ "\$BOUNTY_COMMENT" = "NONE" \]/.test(mergeWorkflow) && /exactly one bounty_issue field/.test(mergeWorkflow) && /exactly one bounty_approval_comment field/.test(mergeWorkflow));
check(
  "bounty URLs bind the canonical repository issue and comment together",
  /ISSUE_PREFIX="https:\/\/github\.com\/\$REPO\/issues\/"/.test(mergeWorkflow) &&
    /COMMENT_PREFIX="\$\{ISSUE_PREFIX\}\$\{BOUNTY_ISSUE_ID\}#issuecomment-"/.test(mergeWorkflow) &&
    /repos\/\$REPO\/issues\/\$BOUNTY_ISSUE_ID/.test(mergeWorkflow) &&
    /repos\/\$REPO\/issues\/comments\/\$BOUNTY_APPROVAL_COMMENT_ID/.test(mergeWorkflow)
);
check(
  "bounty requires a live bounty issue and exact whole-body owner approval",
  /\.state == "open"/.test(mergeWorkflow) &&
    /index\("bounty"\)/.test(mergeWorkflow) &&
    /\.user\.login == "baney75"/.test(mergeWorkflow) &&
    /--arg phrase "BOUNTY APPROVED"/.test(mergeWorkflow) &&
    /\.html_url == \$commentUrl/.test(mergeWorkflow) &&
    /\.issue_url == \$issueUrl/.test(mergeWorkflow) &&
    /\) == \$phrase\)/.test(mergeWorkflow) &&
    !/contains\(\$phrase\)/.test(mergeWorkflow)
);
check("verified bounty identifiers, not PR text, enter the reservation", /bountyIssue: \(\$bountyIssue \| tonumber\)/.test(mergeWorkflow) && /bountyApprovalCommentId: \(\$bountyApprovalCommentId \| tonumber\)/.test(mergeWorkflow));
check("external active maintainers are eligible without GitHub association", !/author_association/.test(mergeWorkflow) && /\.maintainers\[\][\s\S]*\.status == "active"/.test(mergeWorkflow) && /Any \*\*active server-verified maintainer\*\*/.test(maintainGuide));
check("issue-form label prerequisites are exact and documented", /labels:\s*\[bounty\]/.test(bountyForm) && /labels:\s*\[feature\]/.test(featureForm) && /gh label list --repo baney75\/grokplace/.test(runbook) && /required_label in bounty feature/.test(runbook));
check("branch rule requires zero human approvals and three strict non-destructive checks", /zero human approving reviews/.test(runbook) && /strict, current `Tiny perfect PR`, `Secret scan`, and `Trusted agent review`/.test(runbook) && /each bound to GitHub Actions app ID `15368`/.test(runbook) && /enforce the rule for administrators/.test(runbook) && /require conversations to be resolved/.test(runbook) && /disable force pushes and main-branch deletion/.test(runbook));
check("bootstrap keeps one review until trusted workflow reaches main", /do \*\*not\*\* set approvals to zero before the new trusted workflow is on `main`/.test(runbook) && /required approving reviews `1`/.test(runbook));
check("bootstrap permits only a verified sole-owner admin bypass", /verify that `baney75` is the sole admin\/owner/.test(runbook) && /change \*\*only\*\* `enforce_admins` to `false`/.test(runbook) && /restore `enforce_admins: true` and stop/.test(runbook));
check("bootstrap merge is exact-head and final protection names three app-bound checks", /--admin --match-head-commit "\$transition_head"/.test(runbook) && /required approving reviews `0`/.test(runbook) && /require_code_owner_reviews: false/.test(runbook) && /require_last_push_approval: false/.test(runbook) && /strict required checks `Tiny perfect PR`, `Secret scan`, and `Trusted agent review`, each bound to GitHub Actions app ID `15368`/.test(runbook));
check("runbook documents the bounded same-app spoof residual", /app ID `15368` is shared by owner-authored workflows[\s\S]*fork PR tokens are read-only[\s\S]*external non-allowlisted changes fail closed/.test(runbook));
check("live verification proves final transition settings remain unchanged", /After the merged release is live and verified[\s\S]*settings are unchanged/.test(runbook));
check("adversarial guide uses machine-gated distinct identity without owner review", !/current (GitHub )?owner approval/i.test(adversarialGuide) && /No GitHub approval review is required/.test(adversarialGuide) && /distinct verified reviewer identity/.test(adversarialGuide));
check("repository prose keeps issue and PR text non-authoritative", /untrusted PR text is never approval or authority/.test(maintainGuide) && /Issue author text and PR claims do not authorize anything/.test(maintainGuide));
check("workflow actions are commit-pinned", !/^\s*-\s+uses:\s+[^@\s]+@v\d+/m.test(`${qualityWorkflow}\n${mergeWorkflow}`));
check("all paths have an explicit owner", /^\*\s+@baney75\s*$/m.test(codeowners));
check("CODEOWNERS protects itself", /^\/\.github\/CODEOWNERS\s+@baney75\s*$/m.test(codeowners));
const publicActive = publicMaintainer({ github: "owner", agent: "agent-one", status: "active", verifiedAt: 1 });
check("public active maintainer is selectable by the trusted workflow", publicActive?.status === "active" && publicActive.github === "owner" && publicActive.agent === "agent-one");
check("inactive maintainers are not public", publicMaintainer({ github: "owner", agent: "agent-one", status: "pending" }) === null);
for (const path of ["README.md", "docs/guide.md", "docs/icon.webp", "public/styles.css"]) check(`canonical policy accepts ${path}`, isMaintainAwardPath(path));
for (const path of ["docs/app.js", "docs/new.gif", "docs/.github/x.md", ".github/workflows/x.yml", "worker/index.js", "docs/../README.md"]) check(`canonical policy rejects ${path}`, !isMaintainAwardPath(path));
check("maintain award contract names the trusted exact-head machine gate", /trusted exact-head machine gate and merge required/.test(workerSource) && !/owner-approved merge remains required/.test(workerSource));
check("negative consent cannot satisfy the canonical phrase", /phrase !== "yes i consent"/.test(workerSource));
const artifactId = "rv_11111111111111111111111111111111";
const reviewBody = (head, artifact = artifactId) => `## Adversarial review\n- Reviewer: separate adversarial agent (not the implementer)\n- review_artifact_id: ${artifact}\n- head_sha: ${head}\n- Preflight: maintain-preflight → PASS\n- Size: ≤3 files, ≤40 lines, allowlist checked\n- Findings: none found\n- Residual risk: A documentation link could be stale after merge.\n\nVERDICT: SHIP`;
runBody(
  "rejects a template rubber stamp",
  `## Adversarial review\n- Reviewer: separate adversarial agent (not the implementer)\n- review_artifact_id: PASTE_REVIEW_ARTIFACT_ID_HERE\n- head_sha: ${sha}\n- Preflight: maintain-preflight → PASS\n- Size: ≤3 files, ≤40 lines, allowlist checked\n- Findings: none found\n- Residual risk: PASTE_ONE_REAL_SENTENCE_HERE\n\nVERDICT: SHIP`,
  sha,
  1
);
runBody(
  "rejects a stale SHIP",
  reviewBody("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
  sha,
  1
);
runBody("rejects an incidental short SHA", reviewBody(sha).replace(`- head_sha: ${sha}\n`, `- Findings: current short SHA ${sha.slice(0, 7)} has no exact field\n`), sha, 1);
runBody(
  "accepts a complete bound review artifact",
  reviewBody(sha),
  sha,
  0
);

const validArtifact = { ok: true, review: { id: artifactId, reviewerAgent: "critic-agent", headSha: sha, verdict: "SHIP" } };
runArtifact("accepts a verified distinct critic artifact", validArtifact, 0);
runArtifact("rejects a forged artifact id", { ...validArtifact, review: { ...validArtifact.review, id: "rv_22222222222222222222222222222222" } }, 1);
runArtifact("rejects a stale artifact head", { ...validArtifact, review: { ...validArtifact.review, headSha: "f".repeat(40) } }, 1);
runArtifact("rejects the maintainer as its own critic", { ...validArtifact, review: { ...validArtifact.review, reviewerAgent: "author-agent" } }, 1);

const awardName = ["AWARD", "SECRET"].join("_");
const resetName = ["RESET", "SECRET"].join("_");
const providerReference = "$" + "{{ secrets.AWARD_SECRET }}";
runSecret("secret scan accepts an exact provider reference", ".github/workflows/example.yml", `${awardName}: ${providerReference}`, 0);
runSecret("secret scan accepts a named fixture only in tests", "tests/example.mjs", `${awardName}: "test-award-fixture"`, 0);
runSecret("secret scan ignores shell default expansion", ".github/workflows/example.yml", `[ -n "\${${awardName}:-}" ]`, 0);
runSecret("secret scan rejects a mixed literal plus provider line", ".github/workflows/example.yml", `${resetName} = "nonfixture-secret-value" # ${providerReference}`, 1);
runSecret("secret scan rejects a provider assignment with a literal-secret comment", ".github/workflows/example.yml", `${awardName}: ${providerReference} # ${resetName} = "nonfixture-secret-value"`, 1);
runSecret("secret scan rejects a mixed literal plus fixture marker", ".github/workflows/example.yml", `${resetName} = "nonfixture-secret-value" # test-local`, 1);
runSecret("secret scan rejects a JSON literal secret", "config/example.json", `{${JSON.stringify(awardName)}: "nonfixture-secret-value"}`, 1);
runSecret("secret scan rejects a quoted YAML literal secret", ".github/workflows/example.yml", `'${resetName}': 'nonfixture-secret-value'`, 1);
runSecret("secret scan rejects a bracket-key literal secret", "config/example.js", `env[${JSON.stringify(resetName)}] = "nonfixture-secret-value"`, 1);
runSecret("secret scan rejects a setter literal secret", "config/example.js", `env.set(${JSON.stringify(awardName)}, "nonfixture-secret-value")`, 1);
runSecret("secret scan rejects a private key header with a provider marker", ".github/workflows/example.yml", `BEGIN ${"PRIVATE"} KEY # ${providerReference}`, 1);

function runCanvas(name, before, after, expected) {
  const beforeFile = join(temp, `${name}-before.json`);
  const afterFile = join(temp, `${name}-after.json`);
  writeFileSync(beforeFile, JSON.stringify(before));
  writeFileSync(afterFile, JSON.stringify(after));
  const out = spawnSync(process.execPath, ["scripts/canvas-preservation-check.mjs", "--before", beforeFile, "--after", afterFile], {
    cwd: root,
    encoding: "utf8",
  });
  check(name, out.status === expected, `${out.stdout}${out.stderr}`.trim());
}

const board = (values) => Buffer.from(values).toString("base64");
runCanvas(
  "accepts preserved painted cells",
  { ok: true, size: 2, board: board([0, 4, 0, 5]) },
  { ok: true, size: 2, board: board([2, 4, 0, 5]) },
  0
);
runCanvas(
  "rejects blanked painted cells",
  { ok: true, size: 2, board: board([0, 4, 0, 5]) },
  { ok: true, size: 2, board: board([0, 0, 0, 5]) },
  1
);
runCanvas(
  "rejects recolored painted cells",
  { ok: true, size: 2, board: board([0, 4, 0, 5]) },
  { ok: true, size: 2, board: board([0, 7, 0, 5]) },
  1
);
runCanvas(
  "accepts preserved cells after canvas expansion",
  { ok: true, size: 2, board: board([0, 4, 0, 5]) },
  { ok: true, size: 3, board: board([0, 4, 0, 0, 5, 0, 0, 0, 0]) },
  0
);
runCanvas(
  "rejects a blanked cell after canvas expansion",
  { ok: true, size: 2, board: board([0, 4, 0, 5]) },
  { ok: true, size: 3, board: board([0, 4, 0, 0, 0, 0, 0, 0, 0]) },
  1
);

rmSync(temp, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
