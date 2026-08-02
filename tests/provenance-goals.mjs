#!/usr/bin/env node
import { GrokPlaceCanvas } from "../worker/index.js";

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (key && typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = "", limit = 1_000 } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
}

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else { failed++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const owner = "goal-owner";
const guest = "guest-agent";
const planId = "pl_1111111111111111";
const now = Date.now();
const activePlan = {
  id: planId,
  agent: owner,
  clientRequestId: "goal-proof-001",
  title: "Small blue square",
  summary: "A bounded clean mosaic detail.",
  region: "northwest corner",
  bounds: { x: 0, y: 0, w: 4, h: 4 },
  steps: [{ n: 1, text: "Place the square", done: false }],
  design: { w: 4, h: 4, cells: [] },
  tileBudget: 4,
  estimatedTurns: 1,
  status: "active",
  ownerConsentAttestedByAgent: true,
  attestedAt: now,
  progress: { notes: "" },
  acceptedPlacements: 0,
  version: 1,
  activatedVersion: 1,
  createdAt: now,
  updatedAt: now,
};

const storage = new MemoryStorage({
  [`plan:${planId}`]: activePlan,
  planIndex: [{ id: planId, agent: owner, updatedAt: now, status: "active", bounds: activePlan.bounds }],
  [`auth:${owner}`]: { hash: "a".repeat(64), version: 1, createdAt: now },
  [`auth:${guest}`]: { hash: "b".repeat(64), version: 1, createdAt: now },
});
const canvas = new GrokPlaceCanvas({ storage }, { CANVAS_SIZE: "8" });
canvas.rateLimit = async () => ({ ok: true });
canvas.consumeProof = async () => ({ ok: true });
canvas.requireAgentCapability = async () => ({ ok: true });

async function place(agent, body) {
  const request = new Request("https://test/internal/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, goal: "small blue square", challengeId: "test", nonce: 0, ...body }),
  });
  const response = await canvas.handlePlace(request, 8, 60_000, "*", "test-ip");
  return { response, data: await response.json() };
}

let result = await place(owner, {
  planId,
  tiles: [{ x: 0, y: 0, color: 0 }, { x: 1, y: 0, color: 13 }],
});
check(
  "accepted plan placements write one durable provenance record per current tile",
  result.response.ok
    && result.data.plan?.progress?.acceptedPlacements === 2
    && (await storage.get("provenance:row:0"))?.length === 8
    && (await storage.get("provenance:row:0"))?.[0]?.agent === owner
    && (await storage.get("provenance:row:0"))?.[0]?.colorIndex === 0
    && (await storage.get("provenance:row:0"))?.[0]?.planId === planId
    && (await storage.get("provenance:row:0"))?.[0]?.planVersion === 1,
  JSON.stringify(result.data)
);

let response = await canvas.handleTile(new URL("https://test/internal/tile?x=0&y=0"), 8, "*");
let data = await response.json();
check(
  "read-only tile inspector contract returns exact color, provenance, plan, time, and protection state",
  response.ok
    && data.tile?.state === "painted"
    && data.tile?.colorIndex === 0
    && data.tile?.color === "#FFFFFF"
    && data.tile?.placement?.agent === owner
    && typeof data.tile?.placement?.placedAt === "number"
    && /^\d{4}-\d\d-\d\dT/.test(data.tile?.placement?.placedAtIso || "")
    && data.tile?.placement?.goal === "small blue square"
    && data.tile?.placement?.plan?.id === planId
    && data.tile?.placement?.plan?.provenanceVersion === 1
    && data.tile?.placement?.plan?.progress?.serverCalculated === true
    && typeof data.tile?.protection?.protected === "boolean",
  JSON.stringify(data)
);
check("tile reads expose no stored capability material", !JSON.stringify(data).includes("gp_") && !JSON.stringify(data).includes("a".repeat(32)));

response = await canvas.handleTile(new URL("https://test/internal/tile?x=7&y=7"), 8, "*");
data = await response.json();
check("empty tiles have an explicit inspector state", response.ok && data.tile?.state === "empty" && data.tile?.placement === null && data.tile?.color === null, JSON.stringify(data));

result = await place(guest, { planId, x: 2, y: 0, color: 13 });
check("an agent cannot associate placement with an unjoined goal", result.response.status === 403 && result.data.error === "goal_not_joined", JSON.stringify(result.data));

response = await canvas.handleGoalCoordinate(
  new Request("https://test/internal/goals/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: guest, id: planId, intent: "join", challengeId: "test", nonce: 0 }),
  }),
  "*",
  "test-ip"
);
data = await response.json();
check("join records bounded agent-side coordination without a per-goal member list", response.ok && data.relation === "joined" && data.memberships?.joined?.[0] === planId && data.memberships?.maxPerAgent === 4, JSON.stringify(data));

result = await place(guest, { planId, x: 2, y: 0, color: 13 });
const progressedPlan = await storage.get(`plan:${planId}`);
check(
  "joined in-bounds placement advances only the server-calculated goal count",
  result.response.ok && result.data.plan?.progress?.acceptedPlacements === 3 && progressedPlan?.acceptedPlacements === 3 && progressedPlan?.progress?.tilesPlaced === undefined,
  JSON.stringify({ response: result.data, stored: progressedPlan })
);

response = await canvas.handleGoals(new URL(`https://test/internal/goals?x=0&y=0&w=4&h=4&agent=${guest}`), 8, "*");
data = await response.json();
check("regional discovery is bounded and reports the caller relationship", response.ok && data.goals?.length === 1 && data.goals?.[0]?.id === planId && data.goals?.[0]?.relation === "joined" && data.limits?.resultMax === 20, JSON.stringify(data));

response = await canvas.handleGoals(new URL("https://test/internal/goals?x=0&y=0&w=65&h=1"), 8, "*");
data = await response.json();
check("goal discovery rejects oversized regions before listing records", response.status === 400 && data.error === "bad_region", JSON.stringify(data));

result = await place(guest, { planId: "not-a-plan", x: 2, y: 1, color: 13 });
check("placement rejects malformed goal associations", result.response.status === 400 && result.data.error === "bad_plan_id", JSON.stringify(result.data));

const unboundedPlan = { ...activePlan, id: "pl_3333333333333333", bounds: null, status: "proposed" };
const unboundedStorage = new MemoryStorage({ [`plan:${unboundedPlan.id}`]: unboundedPlan, planIndex: [] });
const unboundedCanvas = new GrokPlaceCanvas({ storage: unboundedStorage }, { CANVAS_SIZE: "8" });
unboundedCanvas.rateLimit = async () => ({ ok: true });
unboundedCanvas.consumeProof = async () => ({ ok: true });
unboundedCanvas.requireAgentCapability = async () => ({ ok: true });
response = await unboundedCanvas.handlePlanConfirm(
  new Request("https://test/internal/plan/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: owner, id: unboundedPlan.id, version: 1, ownerConsentAttestedByAgent: true, challengeId: "test", nonce: 0 }),
  }),
  "*",
  "test-ip"
);
data = await response.json();
check("active goals reject missing bounds before they enter regional discovery", response.status === 400 && data.error === "goal_bounds_required", JSON.stringify(data));

const legacyUnboundedPlan = { ...activePlan, id: "pl_4444444444444444", bounds: null, status: "active" };
const legacyUnboundedStorage = new MemoryStorage({ [`plan:${legacyUnboundedPlan.id}`]: legacyUnboundedPlan });
const legacyUnboundedCanvas = new GrokPlaceCanvas({ storage: legacyUnboundedStorage }, { CANVAS_SIZE: "8" });
legacyUnboundedCanvas.rateLimit = async () => ({ ok: true });
legacyUnboundedCanvas.consumeProof = async () => ({ ok: true });
legacyUnboundedCanvas.requireAgentCapability = async () => ({ ok: true });
response = await legacyUnboundedCanvas.handlePlace(new Request("https://test/internal/place", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ agent: owner, goal: "legacy unbounded goal", planId: legacyUnboundedPlan.id, x: 7, y: 7, color: 13 }),
}), 8, 60_000, "*", "test-ip");
data = await response.json();
check(
  "legacy active goals without bounds are paused before placement association",
  response.status === 409
    && data.error === "goal_bounds_required"
    && (await legacyUnboundedStorage.get(`plan:${legacyUnboundedPlan.id}`))?.status === "paused"
    && new Uint8Array(await legacyUnboundedStorage.get("board"))[63] === 0
    && (await legacyUnboundedStorage.get("provenance:row:7")) === undefined,
  JSON.stringify(data)
);

const stalePlan = { ...activePlan, id: "pl_2222222222222222", status: "active", updatedAt: 0 };
const staleStorage = new MemoryStorage({
  [`plan:${stalePlan.id}`]: stalePlan,
  planIndex: [{ id: stalePlan.id, agent: owner, updatedAt: 0, status: "active", bounds: stalePlan.bounds }],
});
const staleCanvas = new GrokPlaceCanvas({ storage: staleStorage }, { CANVAS_SIZE: "8" });
response = await staleCanvas.handleGoals(new URL("https://test/internal/goals?x=0&y=0&w=4&h=4"), 8, "*");
data = await response.json();
check("stale active goals are paused before regional discovery", response.ok && data.goals?.length === 0 && (await staleStorage.get(`plan:${stalePlan.id}`))?.status === "paused", JSON.stringify(data));

const legacyStorage = new MemoryStorage({
  size: 2,
  board: new Uint8Array([1, 0, 0, 0]).buffer,
  scores: new Int16Array(4).buffer,
  schema: 4,
  "owner:0": owner,
});
const legacyCanvas = new GrokPlaceCanvas({ storage: legacyStorage }, {});
response = await legacyCanvas.handleTile(new URL("https://test/internal/tile?x=0&y=0"), 2, "*");
data = await response.json();
check(
  "legacy boards preserve painted cells and report unavailable historical provenance without mutating state",
  response.ok && data.tile?.state === "painted" && data.tile?.placement?.provenance === "legacy_unavailable" && data.tile?.placement?.agent === owner && (await legacyStorage.get("provenance")) === undefined,
  JSON.stringify(data)
);

const schemaThreeStorage = new MemoryStorage({
  size: 2,
  board: new Uint8Array([1, 0, 0, 0]).buffer,
  scores: new Int16Array(4).buffer,
  schema: 3,
});
const schemaThreeCanvas = new GrokPlaceCanvas({ storage: schemaThreeStorage }, {});
response = await schemaThreeCanvas.handleTile(new URL("https://test/internal/tile?x=0&y=0"), 2, "*");
data = await response.json();
check(
  "schema-three color encoding is not migrated a second time when provenance schema is added",
  response.ok && data.tile?.colorIndex === 0 && new Uint8Array(await schemaThreeStorage.get("board"))[0] === 1 && await schemaThreeStorage.get("schema") === 4,
  JSON.stringify(data)
);

process.exitCode = failed ? 1 : 0;
