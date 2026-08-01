#!/usr/bin/env node
/** Minimal regression tests for the offline maintenance gates. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const out = spawnSync(process.execPath, ["scripts/review-artifact-check.mjs", "--file", file, "--artifact", "rv_11111111111111111111111111111111", "--head", sha, "--author-agent", "author-agent"], { cwd: root, encoding: "utf8" });
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
const approvalWorkflow = readFileSync(join(root, ".github/workflows/maintain-approval-signal.yml"), "utf8");
const codeowners = readFileSync(join(root, ".github/CODEOWNERS"), "utf8");
check("privileged workflow uses workflow_run", /workflow_run:/.test(mergeWorkflow) && !/pull_request_target:/.test(mergeWorkflow));
check("owner approval safely retriggers through an unprivileged signal", /Maintain approval signal/.test(mergeWorkflow) && /pull_request_review:/.test(approvalWorkflow) && /review\.user\.login == 'baney75'/.test(approvalWorkflow) && !/secrets\./.test(approvalWorkflow));
check("durable reservations have scheduled and manual reconciliation", /schedule:/.test(mergeWorkflow) && /workflow_dispatch:/.test(mergeWorkflow) && /reconcile-reservations:/.test(mergeWorkflow));
check("privileged workflow checks out the default branch", /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/.test(mergeWorkflow));
check("untrusted PR workflow receives no award secret", !/secrets\.AWARD_SECRET/.test(qualityWorkflow));
check("secret-path guard permits deletion of a forbidden legacy file", /git diff --name-status/.test(qualityWorkflow) && /\$1 !~ \/\^D\//.test(qualityWorkflow) && /files-present-after-pr\.txt/.test(qualityWorkflow));
check("trusted PR workflow runs the path-aware secret diff scanner", /git diff[^\n]+\| node scripts\/credential-diff-scan\.mjs/.test(qualityWorkflow));
check("trusted award workflow is serialized", /group:\s*maintain-awards-\$\{\{ github\.repository \}\}/.test(mergeWorkflow) && /cancel-in-progress:\s*false/.test(mergeWorkflow));
check("merge refuses a bank that cannot accept the full award", /\.bank\.bonusTiles >= 0 and \.bank\.bonusTiles <= 190/.test(mergeWorkflow));
check("trusted workflow resolves the immutable review artifact", /\/v1\/reviews/.test(mergeWorkflow) && /review-artifact-check\.mjs/.test(mergeWorkflow));
check("canonical path checker gates the merge", /maintain-path-check\.mjs/.test(mergeWorkflow));
check("award is reserved before merge and finalized after", mergeWorkflow.indexOf("phase:\"reserve\"") < mergeWorkflow.indexOf("gh pr merge") && mergeWorkflow.indexOf("gh pr merge") < mergeWorkflow.indexOf("phase:\"finalize\""));
check(
  "workflow actions are commit-pinned",
  !/^\s*-\s+uses:\s+[^@\s]+@v\d+/m.test(`${qualityWorkflow}\n${mergeWorkflow}\n${approvalWorkflow}`)
);
check("all paths have an explicit owner", /^\*\s+@baney75\s*$/m.test(codeowners));
check("CODEOWNERS protects itself", /^\/\.github\/CODEOWNERS\s+@baney75\s*$/m.test(codeowners));
const publicActive = publicMaintainer({ github: "owner", agent: "agent-one", status: "active", verifiedAt: 1 });
check("public active maintainer is selectable by the trusted workflow", publicActive?.status === "active" && publicActive.github === "owner" && publicActive.agent === "agent-one");
check("inactive maintainers are not public", publicMaintainer({ github: "owner", agent: "agent-one", status: "pending" }) === null);
for (const path of ["README.md", "docs/guide.md", "docs/icon.webp", "public/styles.css"]) check(`canonical policy accepts ${path}`, isMaintainAwardPath(path));
for (const path of ["docs/app.js", "docs/new.gif", "docs/.github/x.md", ".github/workflows/x.yml", "worker/index.js", "docs/../README.md"]) check(`canonical policy rejects ${path}`, !isMaintainAwardPath(path));
check("negative consent cannot satisfy the canonical phrase", /phrase !== "yes i consent"/.test(readFileSync(join(root, "worker/index.js"), "utf8")));
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
