#!/usr/bin/env node
/**
 * Gate: PR body must prove a SEPARATE adversarial agent reviewed this HEAD
 * and issued VERDICT: SHIP. Blocks template rubber-stamps and stale SHIPs.
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
if (/subagent_id\s*[:=]\s*(\*\*REQUIRED|\.\.\.|TBD|TODO|paste|xxx|your.?id)/i.test(body)) {
  fail("subagent_id is still a placeholder.");
}
if (/Residual risk:\s*$/im.test(naked) || /Residual risk:\s*(\*\*|<!--|\.\.\.)/i.test(body)) {
  fail("Residual risk is empty or placeholder.");
}

// Separate agent claim + real-looking id
const independent =
  /separate\s+(adversarial\s+)?(review\s+)?agent/i.test(naked) ||
  /independent\s+(adversarial\s+)?reviewer/i.test(naked) ||
  /not the implementer/i.test(naked);
if (!independent) {
  fail('Must state review was by a SEPARATE agent ("not the implementer" / "separate adversarial agent").');
} else {
  ok("claims separate reviewer");
}

const idMatch = naked.match(/subagent[_\s-]?id\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{7,80})/i);
if (!idMatch) {
  fail("Need subagent_id: <real id ≥8 chars> from the separate review agent session.");
} else {
  const id = idMatch[1];
  if (
    /^(test|example|sample|placeholder|required|null|undefined)$/i.test(id) ||
    /PASTE|HERE|YOUR|XXX|TODO|TBD|REAL_ID|session/i.test(id)
  ) {
    fail(`subagent_id looks fake/placeholder: ${id}`);
  } else {
    ok(`subagent_id=${id.slice(0, 24)}…`);
  }
}

// VERDICT must be its own line (ignore "replace with VERDICT: SHIP" prose)
if (/^\s*VERDICT:\s*BLOCK\s*$/im.test(naked)) {
  fail("Reviewer VERDICT: BLOCK — do not submit.");
} else if (!/^\s*VERDICT:\s*SHIP\s*$/im.test(naked)) {
  fail('Missing standalone line "VERDICT: SHIP" from the adversarial agent.');
} else {
  ok("VERDICT: SHIP");
}

// Head SHA bind — prevent stale SHIP after new commits (CI always passes HEAD_SHA)
if (headSha) {
  const short = headSha.slice(0, 7).toLowerCase();
  const full = headSha.toLowerCase();
  const lower = naked.toLowerCase();
  if (!lower.includes(short) && !lower.includes(full)) {
    fail(`Body must include this PR head SHA (${short}…) so SHIP cannot be reused after new pushes.`);
  } else {
    ok(`bound to head ${short}`);
  }
} else {
  ok("no HEAD_SHA in env (local) — CI will require it");
}

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
  /subagent_id \/ session:\s*$/im.test(naked) ||
  (naked.includes("VERDICT: SHIP") && /subagent_id \/ session:\s*$/im.test(body.replace(/<!--[\s\S]*?-->/g, "\n")))
) {
  fail("Looks like unfilled PR template — paste a real review.");
}

console.log("");
if (failed) {
  console.error(`Adversarial gate FAILED (${failed}).`);
  console.error("Spawn a SEPARATE review agent on THIS head, paste id + SHA + VERDICT: SHIP.");
  process.exit(1);
}
console.log("Adversarial gate OK.");
process.exit(0);
