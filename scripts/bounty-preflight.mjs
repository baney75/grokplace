#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderBountiesMarkdown, validateBountyCatalog, validateBountyExecution } from "../shared/bounty-policy.js";

const args = process.argv.slice(2);
function required(name) {
  const index = args.indexOf(name);
  const value = index < 0 ? "" : args[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function optional(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] || fallback;
}
function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}
function codeFor(message) {
  if (/scopeHash|catalog has|schema|reward|bountyTypes|suggestion vote|criticRubric|successCriteria/.test(message)) return "CATALOG_SCHEMA_INVALID";
  if (/Markdown drifted/.test(message)) return "CATALOG_MIRROR_DRIFT";
  if (/not found/.test(message)) return "BOUNTY_NOT_FOUND";
  if (/only open/.test(message)) return "BOUNTY_NOT_OPEN";
  if (/required check/.test(message)) return "REQUIRED_CHECK_FAILED";
  if (/changed file record|outside the cataloged scope|rename/.test(message)) return "SCOPE_ESCAPE";
  if (/prior finalized implementations/.test(message)) return "WRITER_TRUST_THRESHOLD_UNMET";
  if (/identit|suggestor|implementer identity|critic identity|Magnus|magnus-only/.test(message)) return "IDENTITY_OR_SCOPE_CLASS_INVALID";
  if (/changed files|changed lines/.test(message)) return "SIZE_LIMIT_EXCEEDED";
  if (/base|head|default branch/.test(message)) return "EXACT_HEAD_OR_BASE_INVALID";
  return "POLICY_INVALID";
}
function reject(message) {
  const reasons = String(message).split("; ").map((detail) => ({ code: codeFor(detail), detail }));
  console.error(JSON.stringify({ ok: false, code: reasons[0].code, reasons }));
  process.exit(1);
}

try {
  const catalogPath = optional("--catalog", "bounties/catalog.json");
  const mirrorPath = optional("--mirror", "BOUNTIES.md");
  const catalog = readJson(catalogPath);
  const catalogErrors = validateBountyCatalog(catalog);
  if (catalogErrors.length) reject(catalogErrors.join("; "));
  if (readFileSync(resolve(mirrorPath), "utf8") !== renderBountiesMarkdown(catalog)) reject("generated Markdown drifted from the protected catalog");
  const result = validateBountyExecution(catalog, {
    bountyId: required("--bounty"),
    base: required("--base"),
    head: required("--head"),
    catalogHead: required("--catalog-head"),
    defaultBranchHead: required("--default-branch-head"),
    lane: required("--lane"),
    authorGithub: required("--author-github"),
    implementerAgent: required("--implementer-agent"),
    criticAgent: required("--critic-agent"),
    files: readJson(required("--files")),
    checks: readJson(required("--checks")),
  });
  if (result.errors.length) reject(result.errors.join("; "));
  console.log(JSON.stringify({ ok: true, code: "BOUNTY_PREFLIGHT_PASS", bountyId: result.bounty.id, bountyWriterCompletions: result.finalizedBountyWriterImplementations.length }));
} catch (error) {
  reject(error.message || String(error));
}
