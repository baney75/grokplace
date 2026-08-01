#!/usr/bin/env node
/**
 * Gate: PR body must name an immutable review artifact for this exact HEAD.
 * Trusted CI resolves the artifact through /v1/reviews before merge.
 *
 * Usage:
 *   node scripts/adversarial-review-check.mjs --body-file path.txt [--head-sha SHA]
 *   BODY=... HEAD_SHA=... node scripts/adversarial-review-check.mjs
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  return args[i + 1] ?? null;
}

let body = flag("--body") ?? process.env.BODY ?? null;
const bodyFile = flag("--body-file");
if (bodyFile) body = readFileSync(bodyFile, "utf8");
if (body == null) {
  try {
    body = readFileSync(0, "utf8");
  } catch {
    body = "";
  }
}
body = String(body || "");
// Strip HTML comments so <!-- placeholders --> don't satisfy checks
const naked = body.replace(/<!--[\s\S]*?-->/g, "").trim();

const headSha = (flag("--head-sha") || process.env.HEAD_SHA || process.env.GITHUB_SHA || "").trim();

let failed = 0;
function fail(msg) {
  failed++;
  console.error(`  FAIL  ${msg}`);
}
function ok(msg) {
  console.log(`  PASS  ${msg}`);
}

console.log("Adversarial review gate\n");

if (naked.length < 120) {
  fail("PR body too short after stripping comments — paste a real separate-agent review.");
} else {
  ok(`body length ${naked.length}`);
}

if (!/##\s*Adversarial review/i.test(naked)) {
  fail('Missing "## Adversarial review" section.');
} else {
  ok("has ## Adversarial review");
}

// Reject unfilled template / pending
if (/VERDICT:\s*PENDING\b/i.test(naked) || /VERDICT:\s*___/i.test(naked)) {
  fail("VERDICT still PENDING / unfilled — spawn separate agent first.");
}
if (/review_artifact_id\s*[:=]\s*(\*\*REQUIRED|\.\.\.|TBD|TODO|paste|xxx|your.?id)/i.test(body)) {
  fail("review_artifact_id is still a placeholder.");
}
if (/Residual risk:\s*$/im.test(naked) || /Residual risk:\s*(\*\*|<!--|\.\.\.)/i.test(body)) {
  fail("Residual risk is empty or placeholder.");
}

// Separate agent claim + platform artifact identifier
const independent =
  /separate\s+(adversarial\s+)?(review\s+)?agent/i.test(naked) ||
  /independent\s+(adversarial\s+)?reviewer/i.test(naked) ||
  /not the implementer/i.test(naked);
if (!independent) {
  fail('Must state review was by a SEPARATE agent ("not the implementer" / "separate adversarial agent").');
} else {
  ok("claims separate reviewer");
}

const artifactMatches = [...naked.matchAll(/^\s*-?\s*review_artifact_id\s*:\s*(rv_[a-f0-9]{32})\s*$/gim)];
if (artifactMatches.length !== 1) fail("Need exactly one review_artifact_id: rv_<32 lowercase hex> field.");
else ok(`review_artifact_id=${artifactMatches[0][1]}`);

// VERDICT must be its own line (ignore "replace with VERDICT: SHIP" prose)
if (/^\s*VERDICT:\s*BLOCK\s*$/im.test(naked)) {
  fail("Reviewer VERDICT: BLOCK — do not submit.");
} else if (!/^\s*VERDICT:\s*SHIP\s*$/im.test(naked)) {
  fail('Missing standalone line "VERDICT: SHIP" from the adversarial agent.');
} else {
  ok("VERDICT: SHIP");
}

// Exact normalized full-SHA field; incidental or abbreviated SHA text never binds a review.
const shaMatches = [...naked.matchAll(/^\s*-?\s*head_sha\s*:\s*([a-f0-9]{40})\s*$/gim)];
if (shaMatches.length !== 1) fail("Need exactly one head_sha: <full 40-character commit SHA> field.");
else if (headSha && shaMatches[0][1].toLowerCase() !== headSha.toLowerCase()) fail("head_sha does not equal the current PR head.");
else ok(`bound to full head ${shaMatches[0][1].toLowerCase()}`);

// Findings / residual substance
const residual = naked.match(/Residual risk:\s*(.+)/i);
const residualText = residual ? residual[1].trim() : "";
if (!residualText || residualText.length < 12 || /PASTE|HERE|TODO|TBD|\.\.\.|your sentence/i.test(residualText)) {
  fail("Residual risk must be a real sentence (≥12 chars, not a placeholder).");
} else {
  ok("residual risk filled");
}

const findingsOk =
  /\b(BLOCKER|MAJOR|MINOR|NIT)\b/i.test(naked) ||
  /none found/i.test(naked) ||
  /no findings/i.test(naked) ||
  /findings:\s*.{8,}/i.test(naked);
if (!findingsOk) {
  fail('Include findings (BLOCKER|MAJOR|MINOR|NIT or "none found").');
} else {
  ok("findings note present");
}

// Preflight / size awareness (must not be only from empty template — require preflight PASS word)
if (!/preflight[^\n]{0,40}PASS/i.test(naked) && !/maintain-preflight[^\n]{0,40}PASS/i.test(naked)) {
  fail('Must note preflight PASS (e.g. "maintain-preflight → PASS").');
} else {
  ok("preflight PASS noted");
}

if (!/(≤\s*3|<=\s*3|max 3|3 files).{0,40}(≤\s*40|<=\s*40|40 lines)|(≤\s*40|<=\s*40|40 lines).{0,40}(≤\s*3|3 files)/is.test(naked)) {
  // looser: both numbers appear near size language
  if (!(/3 files/i.test(naked) && /40 lines/i.test(naked))) {
    fail("Must state ≤3 files and ≤40 lines were checked.");
  } else {
    ok("size budget mentioned");
  }
} else {
  ok("size budget mentioned");
}

if (!/allowlist|worker\/|sensitive path|\.github/i.test(naked)) {
  fail("Must mention path/allowlist/safety check.");
} else {
  ok("path safety mentioned");
}

// Known empty template fingerprint (exact default without fills)
if (
  /review_artifact_id:\s*$/im.test(naked) ||
  (naked.includes("VERDICT: SHIP") && /review_artifact_id:\s*$/im.test(body.replace(/<!--[\s\S]*?-->/g, "\n")))
) {
  fail("Looks like unfilled PR template — paste a real review.");
}

console.log("");
if (failed) {
  console.error(`Adversarial gate FAILED (${failed}).`);
  console.error("Spawn a SEPARATE review agent on THIS head, paste id + SHA + VERDICT: SHIP.");
  process.exit(1);
}
console.log("Adversarial body gate OK; trusted CI must resolve the immutable artifact.");
process.exit(0);
