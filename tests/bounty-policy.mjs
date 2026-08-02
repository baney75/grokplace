#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  SUGGESTION_RETENTION_CAP,
  SUGGESTION_RETENTION_DAYS,
  SUGGESTION_VOTE_CAP,
  bountyScopeHash,
  evaluateSuggestionVote,
  rankSuggestionQueue,
  renderBountiesMarkdown,
  validateBountyCatalog,
} from "../shared/bounty-policy.js";

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "grokplace-bounty-"));
const base = "b".repeat(40);
const head = "c".repeat(40);
const catalogHead = "d".repeat(40);
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function scope(overrides = {}) {
  const value = {
    allowedPaths: ["docs/*.md"],
    maxFiles: 3,
    maxLines: 40,
    nonGoals: ["Do not modify runtime behavior."],
    requiredChecks: ["Secret scan", "Tiny perfect PR"],
    sensitiveAreas: [],
    ...overrides,
  };
  return value;
}

function criterion() {
  return {
    id: "SC-1",
    requirement: "The documented command has a passing and a failing fixture.",
    measure: "tests/bounty-policy.mjs prints the named fixture result.",
    evidenceKind: "command-output",
  };
}

function bounty(id, status, identities, overrides = {}) {
  const boundScope = scope(overrides.scope);
  const value = {
    id,
    type: "docs",
    rewardType: "bonus-tiles-10",
    base: { policy: "exact-sha", sha: base },
    scope: boundScope,
    scopeHash: bountyScopeHash(boundScope),
    status,
    scopeClass: "community",
    identities,
    successCriteria: [criterion()],
    criticRubric: [{ criterionId: "SC-1", mustVerify: "Run the named fixture and inspect its exact output.", reworkIf: "Either fixture is missing, stale, or generic." }],
    ...overrides,
  };
  if (status === "finalized") {
    value.finalization = { headSha: "1".repeat(40), mergeSha: "2".repeat(40), finalizedAt: "2026-08-02T00:00:00Z" };
  }
  return value;
}

function buildCatalog() {
  const catalog = JSON.parse(readFileSync(join(root, "bounties/catalog.json"), "utf8"));
  catalog.bounties = [
    bounty("bp-writer-completion-1", "finalized", { suggestor: "suggestor-one", bountyWriter: "magnus", implementer: "writer-agent", critic: "critic-one" }),
    bounty("bp-writer-completion-2", "finalized", { suggestor: "suggestor-two", bountyWriter: "magnus", implementer: "writer-agent", critic: "critic-two" }),
    bounty("bp-writer-completion-3", "finalized", { suggestor: "suggestor-three", bountyWriter: "magnus", implementer: "writer-agent", critic: "critic-three" }),
    bounty("bp-docs-current", "open", { suggestor: "suggestor-open", bountyWriter: "writer-agent", implementer: "implementer-open", critic: "critic-open" }),
  ];
  return catalog;
}

function writeFixture(catalog, files = [{ filename: "docs/guide.md", status: "modified", changes: 4 }], checks = { check_runs: [
  { name: "Tiny perfect PR", app: { id: 15368 }, status: "completed", conclusion: "success" },
  { name: "Secret scan", app: { id: 15368 }, status: "completed", conclusion: "success" },
] }, mirror = renderBountiesMarkdown(catalog)) {
  const fixture = mkdtempSync(join(temp, "fixture-"));
  const catalogPath = join(fixture, "catalog.json");
  const mirrorPath = join(fixture, "BOUNTIES.md");
  const filesPath = join(fixture, "files.json");
  const checksPath = join(fixture, "checks.json");
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  writeFileSync(mirrorPath, mirror);
  writeFileSync(filesPath, JSON.stringify(files));
  writeFileSync(checksPath, JSON.stringify(checks));
  return { fixture, catalogPath, mirrorPath, filesPath, checksPath };
}

function runPreflight(name, catalog, expected, options = {}) {
  const fixture = writeFixture(catalog, options.files, options.checks, options.mirror);
  const args = [
    "scripts/bounty-preflight.mjs", "--catalog", fixture.catalogPath, "--mirror", fixture.mirrorPath,
    "--bounty", "bp-docs-current", "--base", options.base || base, "--head", options.head || head,
    "--catalog-head", catalogHead, "--default-branch-head", catalogHead, "--lane", options.lane || "maintain",
    "--author-github", "writer-gh", "--implementer-agent", options.implementer || "implementer-open", "--critic-agent", options.critic || "critic-open",
    "--files", fixture.filesPath, "--checks", fixture.checksPath,
  ];
  const out = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  check(name, out.status === expected && (!options.code || `${out.stdout}${out.stderr}`.includes(options.code)), `${out.stdout}${out.stderr}`.trim());
}

function criticBody(evidence = "node tests/bounty-policy.mjs -> PASS valid catalog fixture") {
  return [
    "## Catalog bounty critic evidence",
    "- critic_bounty_id: bp-docs-current",
    "- critic_agent: critic-open",
    `- critic_head_sha: ${head}`,
    "- critic_execution: contributor-pc",
    "- decision: APPROVE",
    `- criterion: SC-1 | PASS | command-output | ${evidence}`,
    "",
  ].join("\n");
}

function runCritic(name, body, expected, code) {
  const catalog = buildCatalog();
  const fixture = writeFixture(catalog);
  const bodyPath = join(fixture.fixture, "body.md");
  writeFileSync(bodyPath, body);
  const out = spawnSync(process.execPath, ["scripts/bounty-critic-evidence-check.mjs", "--catalog", fixture.catalogPath, "--bounty", "bp-docs-current", "--body-file", bodyPath, "--head", head], { cwd: root, encoding: "utf8" });
  check(name, out.status === expected && `${out.stdout}${out.stderr}`.includes(code), `${out.stdout}${out.stderr}`.trim());
}

const liveCatalog = JSON.parse(readFileSync(join(root, "bounties/catalog.json"), "utf8"));
const liveMirror = readFileSync(join(root, "BOUNTIES.md"), "utf8");
const suggestionsGuide = readFileSync(join(root, "SUGGESTIONS.md"), "utf8");
check("repository catalog has no schema errors", validateBountyCatalog(liveCatalog).length === 0, validateBountyCatalog(liveCatalog).join("; "));
check("repository generated bounty mirror is exact", liveMirror === renderBountiesMarkdown(liveCatalog));
check("catalog declares every bounty type", JSON.stringify(liveCatalog.bountyTypes) === JSON.stringify(["suggestion", "docs", "tests", "evidence", "scoped-code", "magnus-only"]));
check("suggestion policy fixes bounded storage caps", liveCatalog.suggestionPolicy.vote.maxVotersPerSuggestion === SUGGESTION_VOTE_CAP && liveCatalog.suggestionPolicy.vote.maxRetainedSuggestions === SUGGESTION_RETENTION_CAP && liveCatalog.suggestionPolicy.vote.retentionDays === SUGGESTION_RETENTION_DAYS && liveCatalog.suggestionPolicy.vote.readCreatesNoState === true);
check("suggestion intake is append-only and explicitly non-authoritative", /append-only intake/.test(suggestionsGuide) && /untrusted proposals/.test(suggestionsGuide) && /<!-- append-new-suggestions-below -->/.test(suggestionsGuide) && /not a bounty catalog, scope approval, reward decision, or merge signal/.test(suggestionsGuide));

runPreflight("accepts an exact cataloged community bounty", buildCatalog(), 0, { code: "BOUNTY_PREFLIGHT_PASS" });
const badHash = buildCatalog();
badHash.bounties.at(-1).scopeHash = "0".repeat(64);
runPreflight("rejects a tampered canonical scope hash", badHash, 1, { code: "CATALOG_SCHEMA_INVALID" });
runPreflight("rejects generated Markdown drift", buildCatalog(), 1, { mirror: "stale\n", code: "CATALOG_MIRROR_DRIFT" });
runPreflight("rejects a path traversal diff", buildCatalog(), 1, { files: [{ filename: "docs/../worker/index.js", status: "modified", changes: 4 }], code: "SCOPE_ESCAPE" });
runPreflight("rejects a rename from an out-of-scope path", buildCatalog(), 1, { files: [{ filename: "docs/guide.md", previous_filename: "worker/index.js", status: "renamed", changes: 4 }], code: "SCOPE_ESCAPE" });
runPreflight("rejects a scope line limit escape", buildCatalog(), 1, { files: [{ filename: "docs/guide.md", status: "modified", changes: 41 }], code: "SIZE_LIMIT_EXCEEDED" });
const insufficientTrust = buildCatalog();
insufficientTrust.bounties = insufficientTrust.bounties.filter((entry) => entry.id !== "bp-writer-completion-3");
runPreflight("rejects a bounty writer below three finalized implementations", insufficientTrust, 1, { code: "WRITER_TRUST_THRESHOLD_UNMET" });
const identityCollision = buildCatalog();
identityCollision.bounties.at(-1).identities.critic = "implementer-open";
runPreflight("rejects a suggestor bounty-writer implementer critic identity collision", identityCollision, 1, { code: "IDENTITY_OR_SCOPE_CLASS_INVALID" });
runPreflight("rejects an implementer that does not match the protected catalog", buildCatalog(), 1, { implementer: "another-agent", code: "IDENTITY_OR_SCOPE_CLASS_INVALID" });
const sensitiveScope = buildCatalog();
sensitiveScope.bounties.at(-1).scope.allowedPaths = ["worker/index.js"];
sensitiveScope.bounties.at(-1).scopeHash = bountyScopeHash(sensitiveScope.bounties.at(-1).scope);
runPreflight("rejects a Worker-sensitive community bounty", sensitiveScope, 1, { code: "IDENTITY_OR_SCOPE_CLASS_INVALID" });
const missingRubric = buildCatalog();
missingRubric.bounties.at(-1).criticRubric = [];
runPreflight("rejects a bounty without a complete critic rubric", missingRubric, 1, { code: "CATALOG_SCHEMA_INVALID" });
runPreflight("rejects a stale exact base", buildCatalog(), 1, { base: "e".repeat(40), code: "EXACT_HEAD_OR_BASE_INVALID" });
runPreflight("rejects a non-exact head", buildCatalog(), 1, { head: "short", code: "EXACT_HEAD_OR_BASE_INVALID" });
runPreflight("rejects a missing required check", buildCatalog(), 1, { checks: { check_runs: [{ name: "Tiny perfect PR", app: { id: 15368 }, status: "completed", conclusion: "success" }] }, code: "REQUIRED_CHECK_FAILED" });

runCritic("accepts structured exact-head criterion evidence", criticBody(), 0, "CRITERION_EVIDENCE_PASS");
runCritic("rejects generic critic approval", criticBody("looks good"), 1, "CRITERION_EVIDENCE_INVALID");
runCritic("rejects a missing criterion row", criticBody().replace(/^- criterion:.*\n/m, ""), 1, "CRITERION_EVIDENCE_MISSING");
runCritic("rejects a critic rework decision", criticBody().replace("decision: APPROVE", "decision: REWORK"), 1, "CRITIC_REWORK");
runCritic("rejects a stale critic head", criticBody().replace(head, "f".repeat(40)), 1, "CRITIC_HEAD_STALE");

let vote = evaluateSuggestionVote({ suggestionId: "sg-catalog-tests", agentId: "voter-one", activeAgent: true, placements: 1, existingAgentIds: [], currentVoterCount: 0 });
check("eligible suggestion vote records one durable delta", vote.ok && vote.outcome === "record" && vote.delta === 1 && vote.key === "sg-catalog-tests:voter-one");
vote = evaluateSuggestionVote({ suggestionId: "sg-catalog-tests", agentId: "VOTER-ONE", activeAgent: true, placements: 1, existingAgentIds: ["voter-one"], currentVoterCount: 1 });
check("suggestion vote retries are idempotent", vote.ok && vote.outcome === "duplicate" && vote.delta === 0);
vote = evaluateSuggestionVote({ suggestionId: "sg-catalog-tests", agentId: "voter-two", activeAgent: true, placements: 1, existingAgentIds: Array.from({ length: SUGGESTION_VOTE_CAP }, (_, index) => `agent-${index}`), currentVoterCount: SUGGESTION_VOTE_CAP });
check("suggestion voter cap fails closed", !vote.ok && vote.errors[0].includes(String(SUGGESTION_VOTE_CAP)));
vote = evaluateSuggestionVote({ suggestionId: "sg-catalog-tests", agentId: "voter-two", activeAgent: true, placements: 0, existingAgentIds: [], currentVoterCount: 0 });
check("ineligible suggestion voter cannot record", !vote.ok && vote.errors.includes("voter is not eligible"));
const ranked = rankSuggestionQueue([
  { id: "sg-b", createdAt: "2026-08-02T00:00:00Z" },
  { id: "sg-a", createdAt: "2026-08-02T00:00:00Z" },
  { id: "sg-c", createdAt: "2026-08-01T00:00:00Z" },
], { "sg-a": 2, "sg-b": 2, "sg-c": 3 });
check("suggestion priority uses votes then deterministic ties", ranked.map((entry) => entry.id).join(",") === "sg-c,sg-a,sg-b");

rmSync(temp, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
