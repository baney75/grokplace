#!/usr/bin/env node
import { GrokPlaceCanvas } from "../worker/index.js";

class TransactionalMemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); this.tail = Promise.resolve(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (key && typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async delete(key) {
    if (Array.isArray(key)) for (const entry of key) this.values.delete(entry);
    else this.values.delete(key);
  }
  async list({ prefix = "", limit = 1_000 } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)); }
  async transaction(callback) {
    const before = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await before;
    try { return await callback(this); } finally { release(); }
  }
}

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else { failed++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const size = 8;
const owner = "tile-owner";
const intruder = "tile-intruder";
const blocker = "tile-blocker";
const paid = "tile-paid";
const forger = "tile-forger";
const planId = "pl_aaaaaaaaaaaaaaaa";
let now = 50_000;
const realNow = Date.now;
Date.now = () => now;

const plan = {
  id: planId,
  agent: owner,
  clientRequestId: "reclaim-plan-001",
  title: "Blue plan",
  summary: "bounded durable ownership proof",
  region: "test",
  bounds: { x: 0, y: 0, w: 5, h: 5 },
  steps: [{ n: 1, text: "paint exact tiles", done: false }],
  design: { w: 5, h: 5, cells: [] },
  tileBudget: 25,
  estimatedTurns: 5,
  status: "active",
  ownerConsentAttestedByAgent: true,
  attestedAt: now,
  progress: { notes: "" },
  acceptedPlacements: 0,
  createdAt: now,
  updatedAt: now,
};
const storage = new TransactionalMemoryStorage({
  size,
  board: new Uint8Array(size * size).buffer,
  scores: new Int16Array(size * size).buffer,
  schema: 4,
  meta: { version: 0, totalPlacements: 0, totalVotes: 0, uniqueAgents: 0, lastPlaceAt: null, tileEpoch: "1".repeat(16) },
  feed: [], history: [], leaders: [],
  [`plan:${planId}`]: plan,
  planIndex: [{ id: planId, agent: owner, updatedAt: now, status: "active", bounds: plan.bounds }],
});
const canvas = new GrokPlaceCanvas({ storage, getWebSockets() { return []; } }, { CANVAS_SIZE: String(size), RESET_SECRET: "test-reset" });
canvas.rateLimit = async () => ({ ok: true });
canvas.consumeProof = async () => ({ ok: true });
canvas.requireAgentCapability = async (request, agent) => request.headers.get("Authorization") === `Agent proof-${agent}`
  ? { ok: true }
  : { ok: false, status: 401, error: "agent_claim_required", message: "capability required" };

function request(agent, path, body) {
  return new Request(`https://test${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Agent proof-${agent}` }, body: JSON.stringify({ agent, challengeId: "test", nonce: 0, ...body }) });
}
async function place(agent, body) {
  const response = await canvas.handlePlace(request(agent, "/internal/place", body), size, 60_000, "*", "test-ip");
  return { response, data: await response.json() };
}
async function protect(agent, body) {
  const response = await canvas.handleProtect(request(agent, "/internal/protect", body), size, 60_000, "*", "test-ip");
  return { response, data: await response.json() };
}
async function reclaim(agent, body) {
  const response = await canvas.handleReclaim(request(agent, "/internal/reclaim", body), size, 60_000, "*", "test-ip");
  return { response, data: await response.json() };
}
async function inventory(agent) {
  const response = await canvas.handleReclaimInventory(new Request(`https://test/internal/reclaim?agent=${agent}&planId=${planId}`, { headers: { Authorization: `Agent proof-${agent}` } }), size, "*");
  return { response, data: await response.json() };
}

try {
  let result = await place(owner, { planId, tiles: [{ x: 1, y: 1, color: 5 }, { x: 2, y: 1, color: 13 }] });
  const row = await storage.get("provenance:row:1");
  check(
    "accepted plan tiles retain authoritative agent plan version step color coordinate time and bounded history",
    result.response.ok
      && row?.[1]?.agent === owner
      && row?.[1]?.planId === planId
      && row?.[1]?.version === result.data.version
      && row?.[1]?.step === 1
      && row?.[2]?.step === 2
      && row?.[1]?.x === 1 && row?.[1]?.y === 1
      && typeof row?.[1]?.placedAt === "number"
      && Array.isArray(row?.[1]?.history) && row[1].history.length === 0,
    JSON.stringify(row)
  );

  result = await place(intruder, { goal: "replace blue tile", x: 1, y: 1, color: 9 });
  const eventIds = await storage.get(`reclaim:agent:${"1".repeat(16)}:${owner}`);
  const event = await storage.get(`reclaim:event:${"1".repeat(16)}:${eventIds?.[0]}`);
  check(
    "a nonparticipant overwrite creates one expiring event-bound restoration right",
    result.response.ok && Array.isArray(eventIds) && eventIds.length === 1 && event?.owner === owner && event?.prior?.colorIndex === 5 && event?.overwritten?.agent === intruder && event?.expiresAt > now,
    JSON.stringify({ result: result.data, event })
  );

  let seen = await inventory(owner);
  check(
    "reclaim inventory is caller-scoped and classifies overwritten plus reclaimable plan tiles",
    seen.response.ok
      && seen.data.inventory?.overwritten?.[0]?.x === 1
      && seen.data.inventory?.reclaimable?.[0]?.eventId === eventIds[0]
      && !JSON.stringify(seen.data).includes(intruder),
    JSON.stringify(seen.data)
  );
  const forged = await canvas.handleReclaimInventory(new Request(`https://test/internal/reclaim?agent=${owner}&planId=${planId}`), size, "*");
  check("reclaim inventory rejects capability forgery", forged.status === 401, await forged.text());
  await storage.put(`agent:${forger}`, { name: forger, placements: 1, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 1, firstAt: now, lastAt: now, lastGoal: "", lastTile: null, bonusTiles: 0, maintainer: false, github: null, joinedPlanIds: [planId], avoidedPlanIds: [] });
  const stolenEvent = await reclaim(forger, { planId, action: "restore", eventId: eventIds[0], clientRequestId: "forged-event-0001" });
  check("a different authenticated agent cannot forge another contributor's restoration event", stolenEvent.response.status === 404 && stolenEvent.data.error === "restoration_not_found", JSON.stringify(stolenEvent.data));

  const ownerStatBeforeRestore = await storage.get(`agent:${owner}`);
  const ownerTurnBeforeRestore = await storage.get(`turn:${owner}`);
  result = await reclaim(owner, { planId, action: "restore", eventId: eventIds[0], clientRequestId: "restore-event-0001" });
  const restoredBoard = new Uint8Array(await storage.get("board"));
  const ownerStatAfterRestore = await storage.get(`agent:${owner}`);
  check(
    "single-use grief restoration restores the exact prior color without normal debit or rewards and adds short protection",
    result.response.ok
      && restoredBoard[1 * size + 1] === 6
      && result.data.chargedCredits === 0
      && result.data.spentTurnTiles === 0
      && (await storage.get(`protection:cell:1:1`))?.expiresAt === now + 120_000
      && (await storage.get(`reclaim:event:${"1".repeat(16)}:${eventIds[0]}`)) === undefined
      && ownerStatAfterRestore?.placements === ownerStatBeforeRestore?.placements
      && ownerStatAfterRestore?.reputation === ownerStatBeforeRestore?.reputation
      && JSON.stringify(await storage.get(`turn:${owner}`)) === JSON.stringify(ownerTurnBeforeRestore),
    JSON.stringify(result.data)
  );
  const replay = await reclaim(owner, { planId, action: "restore", eventId: eventIds[0], clientRequestId: "restore-event-0001" });
  check("restoration replay is durable and cannot restore twice", replay.response.ok && replay.data.replayed === true && replay.data.chargedCredits === 0, JSON.stringify(replay.data));

  now += 121_000;
  await place(intruder, { goal: "overwrite again", x: 1, y: 1, color: 10 });
  const currentIds = await storage.get(`reclaim:agent:${"1".repeat(16)}:${owner}`);
  const blockedEventId = currentIds?.[0];
  await storage.put(`turn:${blocker}`, { left: 5, nextTurnAt: 0 });
  await protect(blocker, { x: 1, y: 1, action: "protect", clientRequestId: "block-restore-0001" });
  result = await reclaim(owner, { planId, action: "restore", eventId: blockedEventId, clientRequestId: "blocked-restore-01" });
  check("restoration cannot bypass active protection", result.response.status === 409 && result.data.error === "protected_tile", JSON.stringify(result.data));
  result = await protect(paid, { x: 1, y: 1, action: "overwrite", color: 0, clientRequestId: "paid-overwrite-0001" });
  check(
    "a valid paid protected overwrite costs exactly three credits and revokes the prior restoration right",
    result.response.ok
      && result.data.chargedCredits === 3
      && (await storage.get(`reclaim:event:${"1".repeat(16)}:${blockedEventId}`)) === undefined
      && !(await storage.get(`reclaim:agent:${"1".repeat(16)}:${owner}`))?.includes(blockedEventId),
    JSON.stringify(result.data)
  );

  now += 901_000;
  await place(intruder, { goal: "fresh overwrite", x: 2, y: 1, color: 8 });
  const expireIds = await storage.get(`reclaim:agent:${"1".repeat(16)}:${owner}`);
  const expiringId = expireIds?.[0];
  const expiring = await storage.get(`reclaim:event:${"1".repeat(16)}:${expiringId}`);
  now = Number(expiring?.expiresAt) + 1;
  result = await reclaim(owner, { planId, action: "restore", eventId: expiringId, clientRequestId: "expired-restore-01" });
  check("expired restoration events fail closed and are removed", result.response.status === 409 && result.data.error === "restoration_expired" && (await storage.get(`reclaim:event:${"1".repeat(16)}:${expiringId}`)) === undefined, JSON.stringify(result.data));

  now += 1;
  result = await reclaim(owner, { planId, action: "reclaim", tiles: [{ x: 2, y: 1, version: row[2].version + 99 }], clientRequestId: "forged-version-01" });
  check("normal reclaim rejects a forged prior version", result.response.status === 409 && result.data.error === "exact_prior_tile_required", JSON.stringify(result.data));
  result = await reclaim(owner, { planId, action: "reclaim", tiles: [{ x: 2, y: 1, version: row[2].version }], clientRequestId: "normal-reclaim-01" });
  const reclaimStat = await storage.get(`agent:${owner}`);
  check(
    "normal reclaim accepts only an exact prior version, uses a normal turn tile, and creates no placement or reputation reward",
    result.response.ok
      && result.data.spentTurnTiles === 1
      && result.data.rewards?.placements === 0
      && new Uint8Array(await storage.get("board"))[1 * size + 2] === 14
      && reclaimStat?.placements === ownerStatBeforeRestore?.placements
      && reclaimStat?.reputation === ownerStatBeforeRestore?.reputation,
    JSON.stringify(result.data)
  );

  await place(owner, { planId, x: 3, y: 1, color: 4 });
  await place(intruder, { goal: "race overwrite", x: 3, y: 1, color: 12 });
  const raceId = (await storage.get(`reclaim:agent:${"1".repeat(16)}:${owner}`))?.[0];
  const race = await Promise.all([
    reclaim(owner, { planId, action: "restore", eventId: raceId, clientRequestId: "race-restore-one" }),
    reclaim(owner, { planId, action: "restore", eventId: raceId, clientRequestId: "race-restore-two" }),
  ]);
  check(
    "transactional restoration races consume one event exactly once",
    race.filter((attempt) => attempt.response.ok).length === 1
      && race.filter((attempt) => attempt.response.status === 404).length === 1
      && new Uint8Array(await storage.get("board"))[1 * size + 3] === 5,
    JSON.stringify(race.map((attempt) => attempt.data))
  );

  result = await place(intruder, { goal: "new unsafe overwrite", x: 2, y: 1, color: 7 });
  const safetyIds = await storage.get(`reclaim:agent:${"1".repeat(16)}:${owner}`);
  const safetyId = safetyIds?.[0];
  for (const reporter of ["reporter-one", "reporter-two", "reporter-three"]) {
    await storage.put(`agent:${reporter}`, { name: reporter, placements: 1, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 1, firstAt: now, lastAt: now, lastGoal: "", lastTile: null, bonusTiles: 0, maintainer: false, github: null, joinedPlanIds: [], avoidedPlanIds: [] });
    const response = await canvas.handleReport(request(reporter, "/internal/report", { x: 2, y: 1, reason: "unsafe" }), size, "*", "test-ip");
    await response.json();
    now += 1;
  }
  result = await reclaim(owner, { planId, action: "restore", eventId: safetyId, clientRequestId: "safety-restore-01" });
  check("safety clear revokes restoration rights and preserves no free recovery path", result.response.status === 404 && result.data.error === "restoration_not_found", JSON.stringify(result.data));

  now += 60_000;
  await place(owner, { planId, x: 4, y: 1, color: 2 });
  await place(intruder, { goal: "filter overwrite", x: 4, y: 1, color: 11 });
  const filteredId = (await storage.get(`reclaim:agent:${"1".repeat(16)}:${owner}`))?.[0];
  const filteredEventKey = `reclaim:event:${"1".repeat(16)}:${filteredId}`;
  const filteredEvent = await storage.get(filteredEventKey);
  await storage.put(filteredEventKey, { ...filteredEvent, prior: { ...filteredEvent.prior, goal: "porn" } });
  result = await reclaim(owner, { planId, action: "restore", eventId: filteredId, clientRequestId: "filtered-restore-01" });
  check("a filtered historical source cannot be restored and its event is removed", result.response.status === 409 && result.data.error === "content_filtered" && (await storage.get(filteredEventKey)) === undefined, JSON.stringify(result.data));

  const resetResponse = await canvas.handleReset(new Request("https://test/internal/reset", { method: "POST", headers: { Authorization: "Bearer test-reset", "Content-Type": "application/json" }, body: "{}" }), "*");
  check("reset advances the epoch and cleans bounded reclaim state", resetResponse.ok && (await storage.list({ prefix: "reclaim:" })).size === 0, await resetResponse.text());
} finally {
  Date.now = realNow;
}

process.exitCode = failed ? 1 : 0;
