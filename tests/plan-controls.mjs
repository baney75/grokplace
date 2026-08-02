#!/usr/bin/env node
import { GrokPlaceCanvas } from "../worker/index.js";

class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
    this.writes = 0;
    this.deletes = 0;
  }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    this.writes++;
    if (key && typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async delete(key) { this.deletes++; this.values.delete(key); }
  async list({ prefix = "", limit = 1_000 } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
}

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else { failed++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const now = Date.now();
const owner = "plan-owner";
const guest = "other-agent";
const planId = "pl_aaaaaaaaaaaaaaaa";
const otherPlanId = "pl_bbbbbbbbbbbbbbbb";
const plan = {
  id: planId,
  agent: owner,
  clientRequestId: "plan-controls-create",
  title: "Exact preview fixture",
  summary: "A bounded fixture for deterministic preview evidence.",
  region: "top left",
  bounds: { x: 0, y: 0, w: 4, h: 4 },
  steps: [{ n: 1, text: "Place the bounded fixture", done: false }],
  design: {
    w: 4,
    h: 4,
    cells: [
      { x: 0, y: 0, c: 5, color: "#E50000" },
      { x: 1, y: 0, c: 5, color: "#E50000" },
      { x: 2, y: 0, c: 5, color: "#E50000" },
      { x: 3, y: 0, c: 5, color: "#E50000" },
      { x: 0, y: 1, c: 5, color: "#E50000" },
      { x: 1, y: 1, c: 5, color: "#E50000" },
      { x: 2, y: 1, c: 5, color: "#E50000" },
    ],
  },
  tileBudget: 7,
  estimatedTurns: 2,
  status: "active",
  ownerConsentAttestedByAgent: true,
  attestedAt: now,
  progress: { notes: "" },
  acceptedPlacements: 1,
  version: 2,
  activatedVersion: 2,
  acceptedReviewId: "pvr_aaaaaaaaaaaaaaaa",
  createdAt: now,
  updatedAt: now,
};

const revision = {
  id: plan.id,
  agent: plan.agent,
  version: 2,
  title: plan.title,
  summary: plan.summary,
  region: plan.region,
  bounds: plan.bounds,
  steps: plan.steps,
  design: plan.design,
  tileBudget: plan.tileBudget,
  estimatedTurns: plan.estimatedTurns,
  createdAt: plan.createdAt,
  revisedAt: plan.updatedAt,
};
const otherPlan = {
  ...plan,
  id: otherPlanId,
  agent: guest,
  title: "Other agent plan",
  clientRequestId: "other-plan-create",
  version: 1,
  activatedVersion: 1,
  createdAt: now,
  updatedAt: now,
};

const board = new Uint8Array(64);
board[0] = 6; // exact current plan tile (palette index 5 + stored offset)
board[1] = 6; // prior-version tile, reclaimed by the latest revision
board[2] = 14; // overwritten current-plan tile
board[3] = 7; // conflicting non-plan tile
board[9] = 14; // protected tile
board[10] = 6; // matching tile without plan provenance
const row0 = Array(8).fill(null);
row0[0] = { agent: owner, colorIndex: 5, placedAt: now, goal: null, planId, planTitle: plan.title, planVersion: 2 };
row0[1] = { agent: owner, colorIndex: 5, placedAt: now, goal: null, planId, planTitle: plan.title, planVersion: 1 };
row0[2] = { agent: owner, colorIndex: 13, placedAt: now, goal: null, planId, planTitle: plan.title, planVersion: 2 };
const row1 = Array(8).fill(null);

const storage = new MemoryStorage({
  size: 8,
  board: board.buffer,
  scores: new Int16Array(64).buffer,
  meta: { version: 7, totalPlacements: 4, totalVotes: 0, uniqueAgents: 2, lastPlaceAt: now, createdAt: now },
  [`plan:${planId}`]: plan,
  [`plan:${otherPlanId}`]: otherPlan,
  [`planrev:${planId}:2`]: revision,
  [`planrevs:${planId}`]: [2, 1],
  planIndex: [
    { id: planId, agent: owner, updatedAt: now, status: "active", bounds: plan.bounds },
    { id: otherPlanId, agent: guest, updatedAt: now, status: "active", bounds: otherPlan.bounds },
  ],
  [`agent:${owner}`]: { name: owner, placements: 2, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 2, firstAt: now, lastAt: now, lastGoal: "", lastTile: null, bonusTiles: 0, maintainer: false, github: null, activePlanId: planId, joinedPlanIds: [], avoidedPlanIds: [] },
  [`agent:${guest}`]: { name: guest, placements: 1, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 1, firstAt: now, lastAt: now, lastGoal: "", lastTile: null, bonusTiles: 0, maintainer: false, github: null, activePlanId: otherPlanId, joinedPlanIds: [], avoidedPlanIds: [] },
  "provenance:row:0": row0,
  "provenance:row:1": row1,
  "protection:cell:1:1": { version: 1, x: 1, y: 1, colorIndex: 13, color: "#0000EA", protector: guest, protectedAt: now - 1_000, expiresAt: now + 60_000 },
});
const canvas = new GrokPlaceCanvas({ storage }, { CANVAS_SIZE: "8" });
canvas.rateLimit = async () => ({ ok: true });
canvas.consumeProof = async () => ({ ok: true });
canvas.requireAgentCapability = async (request, agent) => request.headers.get("Authorization") === `Agent ${agent}-cap`
  ? { ok: true }
  : { ok: false, status: 401, error: "agent_capability_required", message: "capability required" };

const previewUrl = `https://test/internal/plan/preview?id=${planId}&version=2&format=json`;
const writesBeforePreview = storage.writes;
const deletesBeforePreview = storage.deletes;
let response = await canvas.handlePlanPreview(new Request(previewUrl), new URL(previewUrl), 8, "*");
let data = await response.json();
check(
  "preview is observational and returns sparse states, bounds, palette, conflicts, protections, and immutable cache identity",
  response.ok
    && storage.writes === writesBeforePreview
    && storage.deletes === deletesBeforePreview
    && data.preview?.cacheKey === `grokplace-plan-${planId}-v2-board7`
    && response.headers.get("Cache-Control") === "no-store"
    && data.preview?.immutable === false
    && data.preview?.immutableRepresentation?.bitmap === `/v1/plan/preview?id=${planId}&version=2&boardVersion=7&format=png`
    && data.preview?.cells?.length === 7
    && data.preview?.states?.completed === 1
    && data.preview?.states?.reclaimed === 1
    && data.preview?.states?.overwritten === 1
    && data.preview?.states?.conflicting === 1
    && data.preview?.states?.remaining === 1
    && data.preview?.states?.protected === 1
    && data.preview?.states?.planned === 1
    && Array.isArray(data.preview?.palette)
    && data.preview?.dimensions?.canvas?.width === 8,
  JSON.stringify(data)
);

const cacheKey = data.preview?.cacheKey;
const immutablePreviewUrl = `${previewUrl.replace("format=json", "format=png")}&boardVersion=7`;
response = await canvas.handlePlanPreview(new Request(immutablePreviewUrl), new URL(immutablePreviewUrl), 8, "*");
const png = new Uint8Array(await response.arrayBuffer());
check(
  "preview PNG is bounded and cacheable by plan revision plus board version",
  response.ok
    && response.headers.get("Content-Type") === "image/png"
    && response.headers.get("Cache-Control")?.includes("immutable")
    && response.headers.get("ETag") === `"${cacheKey}"`
    && png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71 && png.byteLength < 65_536,
  `${response.status} ${png.byteLength}`
);
response = await canvas.handlePlanPreview(new Request(immutablePreviewUrl, { headers: { "If-None-Match": `"${cacheKey}"` } }), new URL(immutablePreviewUrl), 8, "*");
check("preview cache validators return a deterministic 304", response.status === 304 && response.headers.get("X-Plan-Preview-Key") === cacheKey, String(response.status));
response = await canvas.handlePlanPreview(new Request(`${previewUrl.replace("format=json", "format=ascii")}&boardVersion=7`), new URL(`${previewUrl.replace("format=json", "format=ascii")}&boardVersion=7`), 8, "*");
const ascii = await response.text();
check("preview exposes a bounded non-vision ASCII equivalent", response.ok && response.headers.get("Content-Type")?.startsWith("text/plain") && ascii.includes("# grok/place preview 4x4") && ascii.length < 8_192, ascii.slice(0, 180));

const reviewBody = { agent: guest, planId, planVersion: 2, previewBoardVersion: 7, previewCacheKey: cacheKey, mode: "vision", decision: "ACCEPT", concerns: [], clientRequestId: "vision-review-001", challengeId: "test", nonce: 0 };
response = await canvas.handlePlanReview(new Request("https://test/internal/plan/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reviewBody) }), "*", "test-ip");
data = await response.json();
check("vision review evidence requires an authenticated reviewer", response.status === 401 && data.error === "agent_capability_required", JSON.stringify(data));
response = await canvas.handlePlanReview(new Request("https://test/internal/plan/review", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Agent ${guest}-cap` }, body: JSON.stringify(reviewBody) }), "*", "test-ip");
data = await response.json();
const reviewId = data.review?.id;
check("authenticated vision evidence is immutable and binds the exact preview", response.status === 201 && /^pvr_[a-f0-9]{16}$/.test(reviewId || "") && data.review?.previewCacheKey === cacheKey && data.review?.mode === "vision", JSON.stringify(data));
response = await canvas.handlePlanReviewGet(new URL(`https://test/internal/plan/review?id=${reviewId}`), "*");
data = await response.json();
check("review evidence can be retrieved without mutation using its immutable id", response.ok && response.headers.get("Cache-Control")?.includes("immutable") && data.review?.id === reviewId && data.review?.decision === "ACCEPT", JSON.stringify(data));

const revisionBody = {
  agent: owner,
  id: planId,
  expectedVersion: 2,
  title: "Exact preview fixture revised",
  summary: plan.summary,
  region: plan.region,
  bounds: plan.bounds,
  steps: plan.steps,
  design: plan.design,
  tileBudget: plan.tileBudget,
  estimatedTurns: plan.estimatedTurns,
  status: "proposed",
  progress: { notes: "Revised after review evidence." },
  challengeId: "test",
  nonce: 0,
};
response = await canvas.handlePlanSave(new Request("https://test/internal/plan", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify(revisionBody),
}), "*", "test-ip");
data = await response.json();
const revisedPlan = await storage.get(`plan:${planId}`);
check(
  "plan revisions advance monotonically and clear activation while retaining the reviewed revision",
  response.ok
    && data.plan?.version === 3
    && revisedPlan?.status === "proposed"
    && revisedPlan?.activatedVersion === null
    && (await storage.get(`planrev:${planId}:2`))?.title === plan.title
    && (await storage.get(`planrev:${planId}:3`))?.title === revisionBody.title
    && JSON.stringify(await storage.get(`planrevs:${planId}`)) === JSON.stringify([3, 2, 1]),
  JSON.stringify(data)
);

response = await canvas.handlePlanConfirm(new Request("https://test/internal/plan/confirm", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify({ agent: owner, id: planId, version: 2, ownerConsentAttestedByAgent: true, challengeId: "test", nonce: 0 }),
}), "*", "test-ip");
data = await response.json();
check("activation rejects a stale plan version before changing the active revision", response.status === 409 && data.error === "stale_plan_version" && (await storage.get(`plan:${planId}`))?.activatedVersion === null, JSON.stringify(data));

response = await canvas.handlePlanConfirm(new Request("https://test/internal/plan/confirm", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify({ agent: owner, id: planId, version: 3, ownerConsentAttestedByAgent: true, challengeId: "test", nonce: 0 }),
}), "*", "test-ip");
data = await response.json();
check("versioned activation fails closed without an immutable ACCEPT review", response.status === 409 && data.error === "accepted_review_required" && (await storage.get(`plan:${planId}`))?.status === "proposed", JSON.stringify(data));

response = await canvas.handlePlanConfirm(new Request("https://test/internal/plan/confirm", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify({ agent: owner, id: planId, version: 3, acceptedReviewId: reviewId, ownerConsentAttestedByAgent: true, challengeId: "test", nonce: 0 }),
}), "*", "test-ip");
data = await response.json();
check("versioned activation rejects an ACCEPT review for another plan revision", response.status === 409 && data.error === "accepted_review_mismatch" && (await storage.get(`plan:${planId}`))?.activatedVersion === null, JSON.stringify(data));

const staleReviewBody = { ...reviewBody, planVersion: 3, previewCacheKey: `grokplace-plan-${planId}-v3-board7`, clientRequestId: "vision-review-003-stale" };
response = await canvas.handlePlanReview(new Request("https://test/internal/plan/review", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${guest}-cap` },
  body: JSON.stringify(staleReviewBody),
}), "*", "test-ip");
data = await response.json();
const staleReviewId = data.review?.id;
storage.values.set("meta", { ...(await storage.get("meta")), version: 8 });
response = await canvas.handlePlanConfirm(new Request("https://test/internal/plan/confirm", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify({ agent: owner, id: planId, version: 3, acceptedReviewId: staleReviewId, ownerConsentAttestedByAgent: true, challengeId: "test", nonce: 0 }),
}), "*", "test-ip");
data = await response.json();
check("versioned activation rejects an ACCEPT review whose board and cache identity are stale", response.status === 409 && data.error === "accepted_review_stale" && data.currentBoardVersion === 8 && (await storage.get(`plan:${planId}`))?.activatedVersion === null, JSON.stringify(data));

const currentReviewBody = { ...staleReviewBody, previewBoardVersion: 8, previewCacheKey: `grokplace-plan-${planId}-v3-board8`, clientRequestId: "vision-review-003-current" };
response = await canvas.handlePlanReview(new Request("https://test/internal/plan/review", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${guest}-cap` },
  body: JSON.stringify(currentReviewBody),
}), "*", "test-ip");
data = await response.json();
const currentReviewId = data.review?.id;
response = await canvas.handlePlanConfirm(new Request("https://test/internal/plan/confirm", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify({ agent: owner, id: planId, version: 3, acceptedReviewId: currentReviewId, ownerConsentAttestedByAgent: true, challengeId: "test", nonce: 0 }),
}), "*", "test-ip");
data = await response.json();
const activatedPlan = await storage.get(`plan:${planId}`);
check("only the immutable ACCEPT review for the current preview activates the revised plan", response.ok && data.plan?.version === 3 && activatedPlan?.activatedVersion === 3 && activatedPlan?.acceptedReviewId === currentReviewId, JSON.stringify(data));

response = await canvas.handlePlace(new Request("https://test/internal/place", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify({ agent: owner, goal: "exact preview fixture", planId, x: 3, y: 3, color: 5, challengeId: "test", nonce: 0 }),
}), 8, 60_000, "*", "test-ip");
data = await response.json();
check(
  "only the reviewed active revision permits placement with matching immutable provenance",
  response.ok
    && data.plan?.version === 3
    && (await storage.get("provenance:row:3"))?.[3]?.planId === planId
    && (await storage.get("provenance:row:3"))?.[3]?.planVersion === 3,
  JSON.stringify(data)
);
const boardBeforeReset = new Uint8Array(await storage.get("board"));

const resetRequest = { agent: owner, id: planId, version: 3, dryRun: true, clientRequestId: "owner-reset-001", challengeId: "test", nonce: 0 };
response = await canvas.handlePlanReset(new Request("https://test/internal/plan/reset", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify(resetRequest),
}), "*", "test-ip");
data = await response.json();
const confirmationId = data.confirmationId;
check("owner plan reset begins with a dry-run that promises no board or other-plan changes", response.ok && data.dryRun === true && data.boardChanges === 0 && data.otherPlanChanges === 0 && typeof confirmationId === "string", JSON.stringify(data));
response = await canvas.handlePlanReset(new Request("https://test/internal/plan/reset", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${guest}-cap` },
  body: JSON.stringify({ ...resetRequest, agent: guest }),
}), "*", "test-ip");
data = await response.json();
check("an agent cannot reset another agent's plan or assignment", response.status === 404 && data.error === "not_yours", JSON.stringify(data));
response = await canvas.handlePlanReset(new Request("https://test/internal/plan/reset", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify({ ...resetRequest, dryRun: false, confirmationId }),
}), "*", "test-ip");
data = await response.json();
const afterBoard = new Uint8Array(await storage.get("board"));
response = await canvas.handlePlanReset(new Request("https://test/internal/plan/reset", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Agent ${owner}-cap` },
  body: JSON.stringify({ ...resetRequest, dryRun: false, confirmationId }),
}), "*", "test-ip");
const replay = await response.json();
check(
  "confirmed owner reset is version-bound, idempotent, and contained to the owner plan state",
  response.ok
    && replay.already === true
    && data.boardChanges === 0
    && afterBoard[0] === boardBeforeReset[0] && afterBoard[9] === boardBeforeReset[9]
    && (await storage.get(`plan:${planId}`))?.status === "draft"
    && (await storage.get(`agent:${owner}`))?.activePlanId === null
    && (await storage.get(`plan:${otherPlanId}`))?.status === "active"
    && (await storage.get(`agent:${guest}`))?.activePlanId === otherPlanId,
  JSON.stringify(data)
);

storage.values.set("meta", { ...(await storage.get("meta")), version: 8 });
response = await canvas.handlePlanPreview(new Request(immutablePreviewUrl), new URL(immutablePreviewUrl), 8, "*");
data = await response.json();
check("immutable preview URLs fail closed when their bound board version is stale", response.status === 409 && data.error === "stale_preview" && data.currentBoardVersion === 8, JSON.stringify(data));

process.exitCode = failed ? 1 : 0;
