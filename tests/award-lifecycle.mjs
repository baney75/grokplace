#!/usr/bin/env node
import { GrokPlaceCanvas } from "../worker/index.js";

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (typeof key === "object" && key !== null) for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = "", limit = 1000, startAfter = "" } = {}) {
    return new Map([...this.values]
      .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit));
  }
}

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const storage = new MemoryStorage({
  maintainers: [{ github: "owner", agent: "agent-one", status: "active", awards: 0, bonusTilesEarned: 0 }],
  "agent:agent-one": { name: "agent-one", bonusTiles: 0, placements: 1 },
});
const canvas = new GrokPlaceCanvas({ storage }, { AWARD_SECRET: "test-award-secret" });
const headSha = "1".repeat(40);
const mergeSha = "2".repeat(40);
const identity = { phase: "reserve", github: "owner", prNumber: 42, headSha, filesChanged: 1, linesChanged: 3, paths: ["README.md"] };

async function award(body, secret = "test-award-secret") {
  const request = new Request("https://test/internal/maintain/award", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
  const response = await canvas.handleMaintainAward(request, "*");
  return { response, data: await response.json() };
}

let result = await award(identity, "wrong");
check("reservation requires the trusted award secret", result.response.status === 401 && result.data.error === "unauthorized", JSON.stringify(result.data));
result = await award(identity);
check("exact award capacity is reserved before merge", result.response.status === 201 && result.data.reserved === true && result.data.reservation.amount === 10, JSON.stringify(result.data));
result = await award(identity);
check("exact reservation replay is idempotent", result.response.ok && result.data.already === true && result.data.reserved === true, JSON.stringify(result.data));
result = await award({ ...identity, paths: ["docs/other.md"] });
check("conflicting reservation identity is rejected", result.response.status === 409 && result.data.error === "award_identity_conflict", JSON.stringify(result.data));
result = await award({ phase: "finalize", github: "owner", prNumber: 42, headSha, mergeSha });
check("exact merged reservation finalizes once", result.response.ok && result.data.awarded === 10 && result.data.bonusTilesBank === 10, JSON.stringify(result.data));
result = await award({ phase: "finalize", github: "owner", prNumber: 42, headSha, mergeSha });
check("identical finalize replay is idempotent", result.response.ok && result.data.already === true, JSON.stringify(result.data));
result = await award({ phase: "finalize", github: "owner", prNumber: 42, headSha, mergeSha: "3".repeat(40) });
check("conflicting merge SHA replay is rejected", result.response.status === 409 && result.data.error === "award_identity_conflict", JSON.stringify(result.data));

const bountyStorage = new MemoryStorage({
  maintainers: [{ github: "owner", agent: "agent-one", status: "active", awards: 0, bonusTilesEarned: 0 }],
  "agent:agent-one": { name: "agent-one", bonusTiles: 0, placements: 1 },
});
const bountyCanvas = new GrokPlaceCanvas({ storage: bountyStorage }, { AWARD_SECRET: "test-award-secret" });
async function bountyAward(body) {
  const request = new Request("https://test/internal/maintain/award", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-award-secret" }, body: JSON.stringify(body) });
  const response = await bountyCanvas.handleMaintainAward(request, "*");
  return { response, data: await response.json() };
}
const bountyIdentity = {
  phase: "reserve",
  github: "owner",
  prNumber: 701,
  headSha: "7".repeat(40),
  filesChanged: 1,
  linesChanged: 3,
  paths: ["README.md"],
  bountyIssue: 77,
  bountyApprovalCommentId: 8001,
};
result = await bountyAward({ ...bountyIdentity, bountyApprovalCommentId: undefined });
check("bounty reservation requires both issue and owner approval identifiers", result.response.status === 400 && result.data.error === "bounty_evidence_pair_required", JSON.stringify(result.data));
result = await bountyAward({ ...bountyIdentity, bountyIssue: "77" });
check("bounty identifiers must be positive safe integers", result.response.status === 400 && result.data.error === "bad_bounty_evidence", JSON.stringify(result.data));
result = await bountyAward(bountyIdentity);
const firstBountyReservation = result.data.reservation;
let bountyPointer = await bountyStorage.get("award:bounty:77");
check("bounty reservation atomically records an exact durable issue binding", result.response.status === 201 && firstBountyReservation?.bountyIssue === 77 && bountyPointer?.reservationKey === "award:reservation:701:" + "7".repeat(40) && bountyPointer?.status === "reserved", JSON.stringify({ response: result.data, pointer: bountyPointer }));
result = await bountyAward(bountyIdentity);
check("exact bounty reservation replay is idempotent", result.response.ok && result.data.already === true && result.data.reserved === true, JSON.stringify(result.data));
result = await bountyAward({ ...bountyIdentity, bountyApprovalCommentId: 8002 });
check("a changed owner approval cannot alter a bound bounty reservation", result.response.status === 409 && result.data.error === "award_identity_conflict", JSON.stringify(result.data));
result = await bountyAward({ ...bountyIdentity, prNumber: 702, headSha: "8".repeat(40) });
check("one bounty cannot be reserved by a different PR or head", result.response.status === 409 && result.data.error === "bounty_claim_conflict", JSON.stringify(result.data));
result = await bountyAward({ phase: "cancel", prNumber: 701, headSha: "7".repeat(40), reason: "PR closed" });
bountyPointer = await bountyStorage.get("award:bounty:77");
check("cancelling a bounty reservation preserves its audit record and releases the binding", result.response.ok && result.data.cancelled === true && result.data.reservation?.bountyIssue === 77 && bountyPointer?.status === "released", JSON.stringify({ response: result.data, pointer: bountyPointer }));
const reclaimedBountyIdentity = { ...bountyIdentity, prNumber: 702, headSha: "8".repeat(40) };
result = await bountyAward(reclaimedBountyIdentity);
check("a released bounty can be reclaimed by a new exact reservation", result.response.status === 201 && result.data.reservation?.prNumber === 702, JSON.stringify(result.data));
result = await bountyAward({ phase: "finalize", github: "owner", prNumber: 702, headSha: "8".repeat(40), mergeSha: "9".repeat(40) });
bountyPointer = await bountyStorage.get("award:bounty:77");
const finalizedBounty = await bountyStorage.get("award:pr:702");
check("bounty finalization atomically records the award and immutable issue binding", result.response.ok && result.data.awarded === 10 && finalizedBounty?.bountyIssue === 77 && bountyPointer?.status === "awarded" && bountyPointer?.mergeSha === "9".repeat(40), JSON.stringify({ response: result.data, pointer: bountyPointer, award: finalizedBounty }));
result = await bountyAward({ phase: "finalize", github: "owner", prNumber: 702, headSha: "8".repeat(40), mergeSha: "9".repeat(40) });
check("exact bounty finalization replay is idempotent", result.response.ok && result.data.already === true && result.data.reservation?.bountyIssue === 77, JSON.stringify(result.data));
result = await bountyAward({ ...bountyIdentity, prNumber: 703, headSha: "a".repeat(40) });
check("an awarded bounty cannot be claimed again", result.response.status === 409 && result.data.error === "bounty_claim_conflict", JSON.stringify(result.data));

const catalogStorage = new MemoryStorage({
  maintainers: [{ github: "owner", agent: "agent-one", status: "active", awards: 0, bonusTilesEarned: 0 }],
  "agent:agent-one": { name: "agent-one", bonusTiles: 0, placements: 1 },
});
const catalogCanvas = new GrokPlaceCanvas({ storage: catalogStorage }, { AWARD_SECRET: "test-award-secret" });
async function catalogAward(body) {
  const request = new Request("https://test/internal/maintain/award", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-award-secret" }, body: JSON.stringify(body) });
  const response = await catalogCanvas.handleMaintainAward(request, "*");
  return { response, data: await response.json() };
}
const catalogIdentity = { ...identity, prNumber: 801, headSha: "b".repeat(40), catalogBountyId: "bp-safe-docs" };
result = await catalogAward({ ...catalogIdentity, bountyIssue: 1, bountyApprovalCommentId: 2 });
check("catalog and legacy bounty identities cannot be mixed", result.response.status === 400 && result.data.error === "bounty_identity_conflict", JSON.stringify(result.data));
result = await catalogAward(catalogIdentity);
let catalogPointer = await catalogStorage.get("award:catalog-bounty:bp-safe-docs");
check("catalog bounty reservation atomically binds ID PR and exact head", result.response.status === 201 && result.data.reservation?.catalogBountyId === "bp-safe-docs" && catalogPointer?.reservationKey === `award:reservation:801:${"b".repeat(40)}` && catalogPointer?.status === "reserved", JSON.stringify({ response: result.data, pointer: catalogPointer }));
result = await catalogAward(catalogIdentity);
check("catalog bounty reservation replay is idempotent", result.response.ok && result.data.already === true && result.data.reserved === true, JSON.stringify(result.data));
result = await catalogAward({ ...catalogIdentity, prNumber: 802, headSha: "c".repeat(40) });
check("one catalog bounty cannot reserve a second PR", result.response.status === 409 && result.data.error === "bounty_claim_conflict", JSON.stringify(result.data));
result = await catalogAward({ phase: "cancel", prNumber: 801, headSha: "b".repeat(40), reason: "exact head closed" });
catalogPointer = await catalogStorage.get("award:catalog-bounty:bp-safe-docs");
check("catalog bounty cancellation releases its durable claim", result.response.ok && catalogPointer?.status === "released", JSON.stringify({ response: result.data, pointer: catalogPointer }));
const catalogRetry = { ...catalogIdentity, prNumber: 802, headSha: "c".repeat(40) };
result = await catalogAward(catalogRetry);
check("released catalog bounty may bind one replacement exact head", result.response.status === 201 && result.data.reservation?.catalogBountyId === "bp-safe-docs", JSON.stringify(result.data));
result = await catalogAward({ phase: "finalize", github: "owner", prNumber: 802, headSha: "c".repeat(40), mergeSha: "d".repeat(40) });
catalogPointer = await catalogStorage.get("award:catalog-bounty:bp-safe-docs");
check("catalog bounty finalization is durable and exact-head bound", result.response.ok && result.data.awarded === 10 && catalogPointer?.status === "awarded" && catalogPointer?.mergeSha === "d".repeat(40), JSON.stringify({ response: result.data, pointer: catalogPointer }));
result = await catalogAward({ ...catalogIdentity, prNumber: 803, headSha: "e".repeat(40) });
check("finalized catalog bounty can never award again", result.response.status === 409 && result.data.error === "bounty_claim_conflict", JSON.stringify(result.data));

await storage.put("agent:agent-one", { name: "agent-one", bonusTiles: 195, placements: 1 });
result = await award({ ...identity, prNumber: 43, headSha: "4".repeat(40) });
check("reservation refuses partial or overflowing awards", result.response.status === 429 && result.data.error === "bank_cap", JSON.stringify(result.data));
result = await award({ ...identity, prNumber: 44, headSha: "short" });
check("reservation requires a full immutable head SHA", result.response.status === 400 && result.data.error === "award_identity_required", JSON.stringify(result.data));

const crowdedStorage = new MemoryStorage({
  maintainers: [{ github: "owner", agent: "agent-one", status: "active", awards: 0, bonusTilesEarned: 0 }],
  "agent:agent-one": { name: "agent-one", bonusTiles: 0, placements: 1 },
});
for (let index = 0; index < 1000; index++) {
  const prNumber = 10000 + index;
  const sha = index.toString(16).padStart(40, "0");
  await crowdedStorage.put(`award:reservation:${prNumber}:${sha}`, { prNumber, headSha: sha, github: "other", agent: "other-agent", amount: 10, status: "reserved" });
}
const finalSha = "f".repeat(40);
await crowdedStorage.put(`award:reservation:99999:${finalSha}`, { prNumber: 99999, headSha: finalSha, github: "owner", agent: "agent-one", amount: 195, status: "reserved" });
const crowdedCanvas = new GrokPlaceCanvas({ storage: crowdedStorage }, { AWARD_SECRET: "test-award-secret" });
let cursor = "";
let listed = [];
let pages = 0;
do {
  const url = new URL("https://test/internal/maintain/reservations");
  if (cursor) url.searchParams.set("cursor", cursor);
  const request = new Request(url, { headers: { Authorization: "Bearer test-award-secret" } });
  const response = await crowdedCanvas.handleMaintainReservations(request, "*");
  const data = await response.json();
  pages++;
  listed = listed.concat(data.reservations || []);
  cursor = data.nextCursor || "";
} while (cursor && pages < 10);
check("reservation listing paginates beyond the first 1,000 records", pages === 5 && listed.length === 1001 && listed.some((record) => record.prNumber === 99999), `pages=${pages} records=${listed.length}`);
const crowdedRequest = new Request("https://test/internal/maintain/award", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer test-award-secret" },
  body: JSON.stringify({ ...identity, prNumber: 45, headSha: "5".repeat(40) }),
});
const crowdedResponse = await crowdedCanvas.handleMaintainAward(crowdedRequest, "*");
const crowdedData = await crowdedResponse.json();
check("bank capacity includes a reservation after record 1,000", crowdedResponse.status === 429 && crowdedData.error === "bank_cap" && crowdedData.reservedTiles === 195, JSON.stringify(crowdedData));

process.exitCode = failed ? 1 : 0;
