#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { validateBountyCatalog } from "../shared/bounty-policy.js";

const args = process.argv.slice(2);
function required(name) {
  const index = args.indexOf(name);
  const value = index < 0 ? "" : args[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function field(body, name) {
  const matches = [...body.matchAll(new RegExp(`^[\\t ]*-[\\t ]*${name}[\\t ]*:[\\t ]*(.+?)\\s*$`, "gm"))];
  if (matches.length !== 1) throw new Error(`${name} must appear exactly once`);
  return matches[0][1].trim();
}
function evidenceRows(body) {
  return [...body.matchAll(/^[\t ]*-[\t ]*criterion:[\t ]*(SC-[1-9][0-9]*)[\t ]*\|[\t ]*(PASS|REWORK)[\t ]*\|[\t ]*([a-z-]+)[\t ]*\|[\t ]*(.+?)\s*$/gm)]
    .map((match) => ({ id: match[1], result: match[2], kind: match[3], evidence: match[4].trim() }));
}
function genericEvidence(value) {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized.length < 18 || /^(pass|passed|ok|looks good|verified|none|n\/a|same as above|all good)[.! ]*$/.test(normalized) || /paste|placeholder|todo|tbd/.test(normalized);
}
function codeFor(message) {
  if (/not found|catalog/.test(message)) return "CATALOG_SCHEMA_INVALID";
  if (/head SHA|full SHA/.test(message)) return "CRITIC_HEAD_STALE";
  if (/decision/.test(message) || /not PASS/.test(message)) return "CRITIC_REWORK";
  if (/exactly one row|unknown or duplicate|criterion/.test(message)) return "CRITERION_EVIDENCE_MISSING";
  if (/generic|evidence kind/.test(message)) return "CRITERION_EVIDENCE_INVALID";
  if (/agent|execution/.test(message)) return "CRITIC_IDENTITY_INVALID";
  return "CRITIC_EVIDENCE_INVALID";
}
function reject(message) {
  console.error(JSON.stringify({ ok: false, code: codeFor(String(message)), message: String(message) }));
  process.exit(1);
}

try {
  const catalog = JSON.parse(readFileSync(required("--catalog"), "utf8"));
  const errors = validateBountyCatalog(catalog);
  if (errors.length) reject(errors.join("; "));
  const bountyId = required("--bounty");
  const bounty = catalog.bounties.find((entry) => entry.id === bountyId);
  if (!bounty) throw new Error("catalog bounty was not found");
  const body = readFileSync(required("--body-file"), "utf8");
  const head = required("--head");
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("--head must be a full SHA");
  if (field(body, "critic_bounty_id") !== bounty.id) throw new Error("critic evidence bounty id does not match catalog");
  if (field(body, "critic_agent").toLowerCase() !== bounty.identities.critic.toLowerCase()) throw new Error("critic evidence agent does not match catalog");
  if (field(body, "critic_head_sha") !== head) throw new Error("critic evidence head SHA is not exact");
  if (field(body, "decision") !== "APPROVE") throw new Error("critic decision must be APPROVE; REWORK and generic approvals fail closed");
  if (field(body, "critic_execution") !== "contributor-pc") throw new Error("critic execution must be the contributor-pc operational attestation");
  const rows = evidenceRows(body);
  if (rows.length !== bounty.successCriteria.length) throw new Error("critic evidence must contain exactly one row for every success criterion");
  const rubric = new Map(bounty.criticRubric.map((item) => [item.criterionId, item]));
  const criteria = new Map(bounty.successCriteria.map((item) => [item.id, item]));
  const seen = new Set();
  for (const row of rows) {
    if (!criteria.has(row.id) || seen.has(row.id)) throw new Error(`critic evidence has an unknown or duplicate criterion: ${row.id}`);
    seen.add(row.id);
    if (row.result !== "PASS") throw new Error(`${row.id} is not PASS`);
    if (row.kind !== criteria.get(row.id).evidenceKind) throw new Error(`${row.id} evidence kind does not match the catalog criterion`);
    if (genericEvidence(row.evidence)) throw new Error(`${row.id} evidence is generic or incomplete`);
    if (!rubric.has(row.id)) throw new Error(`${row.id} has no protected critic rubric`);
  }
  console.log(JSON.stringify({ ok: true, code: "CRITERION_EVIDENCE_PASS", bountyId: bounty.id, headSha: head, criteria: bounty.successCriteria.map((criterion) => criterion.id) }));
} catch (error) {
  reject(error.message || String(error));
}
