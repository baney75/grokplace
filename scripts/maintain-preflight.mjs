#!/usr/bin/env node
/**
 * Fast maintain preflight — run BEFORE opening a maintain PR.
 *
 * Usage:
 *   node scripts/maintain-preflight.mjs
 *   node scripts/maintain-preflight.mjs --base origin/main --head HEAD
 *   node scripts/maintain-preflight.mjs --require-maintain-paths  # fail if any non-allowlist file
 *
 * Exit 0 = ok for maintain award path.
 * Exit 2 = not a maintain-only diff (owner/product PR — skip award path).
 * Exit 1 = maintain-shaped but failed checks.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMaintainAwardPath } from "../shared/maintain-policy.js";

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
}
const has = (name) => args.includes(name);

const BASE = flag("--base", "origin/main");
const HEAD = flag("--head", "HEAD");
const REQUIRE_MAINTAIN = has("--require-maintain-paths");
const ROOT = process.cwd();

const MAX_FILES = 3;
const MAX_LINES = 40;

let failed = 0;
function fail(msg) {
  failed++;
  console.error(`  FAIL  ${msg}`);
}
function ok(msg) {
  console.log(`  PASS  ${msg}`);
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: ROOT }).trim();
}

console.log(`Maintain preflight · base=${BASE} head=${HEAD}\n`);

let files = [];
let totalLines = 0;
try {
  try {
    sh(`git rev-parse --verify ${BASE}`);
  } catch {
    try {
      sh(`git fetch origin main --depth=1`);
    } catch {
      /* offline */
    }
  }
  const nameOut = sh(`git diff --name-only ${BASE}...${HEAD}`);
  files = nameOut ? nameOut.split("\n").filter(Boolean) : [];
  const stat = sh(`git diff --numstat ${BASE}...${HEAD}`);
  for (const line of stat.split("\n").filter(Boolean)) {
    const [a, d] = line.split("\t");
    totalLines += (a === "-" ? 0 : Number(a) || 0) + (d === "-" ? 0 : Number(d) || 0);
  }
} catch (err) {
  fail(`git diff failed: ${err.message || err}`);
  process.exit(1);
}

if (!files.length) {
  fail("No changed files.");
  process.exit(1);
}

const allMaintain = files.every(isMaintainAwardPath);

if (!allMaintain) {
  console.log(`  INFO  Not a maintain-only diff (${files.length} files, ${totalLines} lines).`);
  console.log("  INFO  Product/owner PRs skip the maintain award path.");
  if (REQUIRE_MAINTAIN || has("--strict")) {
    fail("Expected maintain-only allowlisted paths.");
    process.exit(1);
  }
  // Exit 2 = caller (CI) should skip adversarial award gates
  console.log("\nSKIP maintain gates (exit 2) — not an awardable maintain PR shape.");
  process.exit(2);
}

ok(`${files.length} file(s), ${totalLines} line(s) — maintain path`);

if (files.length > MAX_FILES) fail(`Too many files (${files.length}). Max ${MAX_FILES}.`);
else ok(`file count ≤ ${MAX_FILES}`);

if (totalLines > MAX_LINES) fail(`Diff too large (${totalLines} lines). Max ${MAX_LINES}.`);
else if (totalLines < 1) fail("Empty diff.");
else ok(`line count ≤ ${MAX_LINES}`);

for (const f of files) {
  if (!isMaintainAwardPath(f)) fail(`Not allowlisted: ${f}`);
  else ok(`allowlisted: ${f}`);
}

try {
  const patch = sh(`git diff ${BASE}...${HEAD}`);
  if (
    /BEGIN (RSA |OPENSSH )?PRIVATE KEY|api[_-]?key\s*[:=]|AWARD_SECRET|RESET_SECRET\s*=\s*['"][^'"]+|password\s*[:=]\s*['"][^'"]{8,}/i.test(
      patch
    )
  ) {
    fail("Possible secret material in diff.");
  } else {
    ok("no secret patterns in diff");
  }
} catch {
  fail("could not read patch");
}

for (const f of files) {
  if (!/\.md$/i.test(f) || !existsSync(join(ROOT, f))) continue;
  const text = readFileSync(join(ROOT, f), "utf8");
  if (/\bGrok Place\b/.test(text) && !/not [“"]Grok Place/.test(text)) {
    fail(`${f}: brand must be grok/place`);
  }
}

for (const f of files) {
  if (!existsSync(join(ROOT, f))) continue;
  const text = readFileSync(join(ROOT, f), "utf8");
  if (/(<script\b|\bon[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html|<iframe\b)/i.test(text)) {
    fail(`${f}: executable or embedded HTML is not allowed on the award path`);
  }
}

console.log("");
if (failed) {
  console.error(`Preflight FAILED (${failed}).`);
  process.exit(1);
}
console.log("Preflight OK — spawn SEPARATE adversarial agent next (ADVERSARIAL.md).");
process.exit(0);
