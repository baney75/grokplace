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
async function footprintReset(agent, body) {
  const response = await canvas.handlePlanFootprintReset(request(agent, "/internal/plan/footprint-reset", body), size, "*", "test-ip");
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

  const footprintPlanId = "pl_bbbbbbbbbbbbbbbb";
  const footprintPlan = {
    ...plan,
    id: footprintPlanId,
    clientRequestId: "footprint-plan-001",
    title: "Footprint plan",
    bounds: { x: 0, y: 5, w: 4, h: 1 },
    version: 1,
    activatedVersion: 1,
    acceptedReviewId: "pvr_bbbbbbbbbbbbbbbb",
    updatedAt: now,
  };
  await storage.put(`plan:${footprintPlanId}`, footprintPlan);
  await storage.put("planIndex", [
    ...(await storage.get("planIndex")),
    { id: footprintPlanId, agent: owner, updatedAt: now, status: "active", bounds: footprintPlan.bounds },
  ]);
  await storage.put(`turn:${owner}`, { left: 5, nextTurnAt: 0 });
  result = await place(owner, {
    planId: footprintPlanId,
    tiles: [{ x: 0, y: 5, color: 5 }, { x: 1, y: 5, color: 5 }, { x: 2, y: 5, color: 5 }, { x: 3, y: 5, color: 5 }],
  });
  check("footprint reset fixture records current tiles under the exact plan version", result.response.ok && (await storage.get("provenance:row:5"))?.[0]?.planVersion === 1, JSON.stringify(result.data));
  await storage.put(`turn:${blocker}`, { left: 5, nextTurnAt: 0 });
  result = await protect(blocker, { x: 1, y: 5, action: "protect", clientRequestId: "footprint-protect-01" });
  await storage.put(`turn:${intruder}`, { left: 5, nextTurnAt: 0 });
  await place(intruder, { goal: "foreign footprint overwrite", x: 2, y: 5, color: 12 });
  const safetyBoard = new Uint8Array(await storage.get("board"));
  const safetyRow = await storage.get("provenance:row:5");
  safetyBoard[5 * size + 3] = 0;
  safetyRow[3] = { ...safetyRow[3], clearedAt: now, clearedReason: "safety" };
  const safetyMeta = await storage.get("meta");
  await storage.put({ board: safetyBoard.buffer, ["provenance:row:5"]: safetyRow, meta: { ...safetyMeta, version: safetyMeta.version + 1 } });

  const beforeFootprintStat = { ...(await storage.get(`agent:${owner}`)) };
  const beforeFootprintMeta = { ...(await storage.get("meta")) };
  let footprint = await footprintReset(owner, { id: footprintPlanId, version: 1, boardVersion: beforeFootprintMeta.version, dryRun: true, clientRequestId: "footprint-reset-001" });
  const firstFootprintHash = footprint.data.footprint?.hash;
  const firstConfirmationId = footprint.data.confirmationId;
  check(
    "footprint dry-run derives the exact current plan/version footprint and excludes protected, foreign, and safety-cleared cells",
    footprint.response.ok
      && footprint.data.footprint?.ownedCurrentCount === 2
      && footprint.data.footprint?.clearableCount === 1
      && footprint.data.footprint?.protectedCount === 1
      && typeof firstFootprintHash === "string"
      && typeof firstConfirmationId === "string",
    JSON.stringify(footprint.data)
  );
  result = await footprintReset(owner, { id: footprintPlanId, version: 1, boardVersion: beforeFootprintMeta.version, footprintHash: "0".repeat(64), dryRun: false, confirmationId: firstConfirmationId, clientRequestId: "footprint-reset-001" });
  check("footprint confirmation rejects a forged exact-footprint binding without clearing", result.response.status === 409 && result.data.error === "footprint_confirmation_required" && new Uint8Array(await storage.get("board"))[5 * size] !== 0, JSON.stringify(result.data));

  await storage.put("meta", { ...(await storage.get("meta")), version: beforeFootprintMeta.version + 1 });
  result = await footprintReset(owner, { id: footprintPlanId, version: 1, boardVersion: beforeFootprintMeta.version, footprintHash: firstFootprintHash, dryRun: false, confirmationId: firstConfirmationId, clientRequestId: "footprint-reset-001" });
  check("footprint confirmation fails closed when the bound board version is stale", result.response.status === 409 && result.data.error === "footprint_stale_board", JSON.stringify(result.data));

  const freshFootprintMeta = await storage.get("meta");
  const freshFootprintBoardVersion = freshFootprintMeta.version;
  footprint = await footprintReset(owner, { id: footprintPlanId, version: 1, boardVersion: freshFootprintBoardVersion, dryRun: true, clientRequestId: "footprint-reset-002" });
  const freshFootprintHash = footprint.data.footprint?.hash;
  const freshConfirmationId = footprint.data.confirmationId;
  const footprintStatBeforeConfirm = { ...(await storage.get(`agent:${owner}`)) };
  const footprintMetaBeforeConfirm = { ...(await storage.get("meta")) };
  result = await footprintReset(owner, { id: footprintPlanId, version: 1, boardVersion: freshFootprintBoardVersion, footprintHash: freshFootprintHash, dryRun: false, confirmationId: freshConfirmationId, clientRequestId: "footprint-reset-002" });
  const footprintBoardAfterConfirm = new Uint8Array(await storage.get("board"));
  const footprintRowAfterConfirm = await storage.get("provenance:row:5");
  const creditsAfterConfirm = await storage.get(`relocationcredits:${owner}`);
  check(
    "confirmed footprint reset clears only current unprotected exact-plan tiles, audits provenance, and issues the exact relocation credit count",
    result.response.ok
      && result.data.clearedCount === 1
      && result.data.relocationCredit?.amount === 1
      && footprintBoardAfterConfirm[5 * size] === 0
      && footprintBoardAfterConfirm[5 * size + 1] !== 0
      && footprintBoardAfterConfirm[5 * size + 2] !== 0
      && footprintBoardAfterConfirm[5 * size + 3] === 0
      && footprintRowAfterConfirm?.[0]?.action === "footprint_reset"
      && footprintRowAfterConfirm?.[0]?.clearedReason === "footprint_reset"
      && Array.isArray(creditsAfterConfirm) && creditsAfterConfirm.length === 1 && creditsAfterConfirm[0]?.amount === 1,
    JSON.stringify(result.data)
  );
  const footprintReplay = await footprintReset(owner, { id: footprintPlanId, version: 1, boardVersion: freshFootprintBoardVersion, footprintHash: freshFootprintHash, dryRun: false, confirmationId: freshConfirmationId, clientRequestId: "footprint-reset-002" });
  const footprintStatAfterConfirm = await storage.get(`agent:${owner}`);
  const footprintMetaAfterConfirm = await storage.get("meta");
  check(
    "footprint reset replay is idempotent and cannot inflate bonus bank, placements, reputation, protection, or total placement counts",
    footprintReplay.response.ok
      && footprintReplay.data.already === true
      && (await storage.get(`relocationcredits:${owner}`))?.length === 1
      && footprintStatAfterConfirm?.bonusTiles === footprintStatBeforeConfirm?.bonusTiles
      && footprintStatAfterConfirm?.placements === footprintStatBeforeConfirm?.placements
      && footprintStatAfterConfirm?.reputation === footprintStatBeforeConfirm?.reputation
      && footprintMetaAfterConfirm?.totalPlacements === footprintMetaBeforeConfirm?.totalPlacements
      && beforeFootprintStat?.bonusTiles === footprintStatBeforeConfirm?.bonusTiles,
    JSON.stringify({ replay: footprintReplay.data, before: footprintStatBeforeConfirm, after: footprintStatAfterConfirm, meta: footprintMetaAfterConfirm })
  );
  now = Number(creditsAfterConfirm?.[0]?.expiresAt) + 1;
  check("relocation credits expire without becoming bonus-bank or placement credit", (await canvas.readRelocationCredits(storage, owner, now)).length === 0 && (await storage.get(`agent:${owner}`))?.bonusTiles === footprintStatAfterConfirm?.bonusTiles);

  const batchPlanId = "pl_cccccccccccccccc";
  const batchEpoch = "2".repeat(16);
  const batchBoard = new Uint8Array(size * size);
  const batchRows = {};
  for (let y = 0; y < size; y++) batchRows[`provenance:row:${y}`] = Array(size).fill(null);
  for (let index = 0; index < 40; index++) {
    const x = index % size;
    const y = Math.floor(index / size);
    batchBoard[index] = 6;
    batchRows[`provenance:row:${y}`][x] = {
      version: index + 1,
      agent: owner,
      colorIndex: 5,
      placedAt: now,
      goal: "bounded batch fixture",
      planId: batchPlanId,
      planTitle: "Batch footprint plan",
      planVersion: 1,
      assignmentId: null,
      step: 1,
      x,
      y,
      action: index === 2 ? "restore" : "place",
      history: [],
    };
  }
  const foreignCoordinate = { x: 0, y: 5 };
  batchBoard[foreignCoordinate.y * size + foreignCoordinate.x] = 10;
  batchRows["provenance:row:5"][0] = {
    version: 41,
    agent: intruder,
    colorIndex: 9,
    placedAt: now,
    goal: "foreign overwrite",
    planId: null,
    planTitle: null,
    assignmentId: null,
    step: null,
    x: foreignCoordinate.x,
    y: foreignCoordinate.y,
    action: "overwrite",
    history: [],
  };
  const batchPlan = {
    ...plan,
    id: batchPlanId,
    clientRequestId: "batch-footprint-plan",
    title: "Batch footprint plan",
    bounds: { x: 0, y: 0, w: size, h: size },
    design: { w: size, h: size, cells: [] },
    version: 1,
    activatedVersion: 1,
    updatedAt: now,
  };
  const griefEventId = "d".repeat(32);
  const griefSnapshot = {
    version: 40,
    agent: owner,
    colorIndex: 5,
    placedAt: now - 1,
    goal: "bounded batch fixture",
    planId: batchPlanId,
    planTitle: batchPlan.title,
    planVersion: 1,
    assignmentId: null,
    step: 1,
    x: foreignCoordinate.x,
    y: foreignCoordinate.y,
    action: "place",
  };
  const batchStorage = new TransactionalMemoryStorage({
    size,
    board: batchBoard.buffer,
    scores: new Int16Array(size * size).buffer,
    schema: 4,
    meta: { version: 50, totalPlacements: 41, totalVotes: 0, uniqueAgents: 2, lastPlaceAt: now, tileEpoch: batchEpoch },
    feed: [],
    history: [],
    leaders: [],
    [`plan:${batchPlanId}`]: batchPlan,
    planIndex: [{ id: batchPlanId, agent: owner, updatedAt: now, status: "active", bounds: batchPlan.bounds }],
    [`agent:${owner}`]: { name: owner, placements: 40, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 40, firstAt: now, lastAt: now, lastGoal: "", lastTile: null, bonusTiles: 0, maintainer: false, github: null, activePlanId: batchPlanId, joinedPlanIds: [], avoidedPlanIds: [] },
    [`reclaim:event:${batchEpoch}:${griefEventId}`]: { version: 1, id: griefEventId, epoch: batchEpoch, owner, planId: batchPlanId, x: foreignCoordinate.x, y: foreignCoordinate.y, prior: griefSnapshot, overwritten: { ...griefSnapshot, version: 41, agent: intruder, colorIndex: 9, planId: null, planTitle: null, step: null, action: "overwrite" }, createdAt: now, expiresAt: now + 600_000 },
    [`reclaim:agent:${batchEpoch}:${owner}`]: [griefEventId],
    "protection:cell:7:4": { version: 1, x: 7, y: 4, colorIndex: 5, color: "#E50000", protector: blocker, protectedAt: now, expiresAt: now + 60_000 },
    ...batchRows,
  });
  const batchCanvas = new GrokPlaceCanvas({ storage: batchStorage, getWebSockets() { return []; } }, { CANVAS_SIZE: String(size), RESET_SECRET: "test-reset" });
  batchCanvas.rateLimit = async () => ({ ok: true });
  batchCanvas.consumeProof = async () => ({ ok: true });
  batchCanvas.requireAgentCapability = async (incoming, agent) => incoming.headers.get("Authorization") === `Agent proof-${agent}`
    ? { ok: true }
    : { ok: false, status: 401, error: "agent_claim_required", message: "capability required" };
  const batchReset = async (body) => {
    const response = await batchCanvas.handlePlanFootprintReset(request(owner, "/internal/plan/footprint-reset", body), size, "*", "test-ip");
    return { response, data: await response.json() };
  };

  let batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: 50, selected: [{ x: 0, y: 0 }, { x: 0, y: 0 }], dryRun: true, clientRequestId: "batch-duplicate-01" });
  check("explicit footprint selection rejects duplicate coordinates deterministically", batchResult.response.status === 400 && batchResult.data.error === "duplicate_selection", JSON.stringify(batchResult.data));
  batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: 50, selected: [{ x: 8, y: 0 }], dryRun: true, clientRequestId: "batch-bounds-0001" });
  check("explicit footprint selection rejects out-of-bounds coordinates deterministically", batchResult.response.status === 400 && batchResult.data.error === "selection_out_of_bounds", JSON.stringify(batchResult.data));
  batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: 50, selected: [foreignCoordinate], dryRun: true, clientRequestId: "batch-foreign-001" });
  check("foreign griefed tiles are rejected without consuming restoration rights or issuing credits", batchResult.response.status === 409 && batchResult.data.error === "selection_foreign" && await batchStorage.get(`reclaim:event:${batchEpoch}:${griefEventId}`) !== undefined && await batchStorage.get(`relocationcredits:${owner}`) === undefined, JSON.stringify(batchResult.data));
  batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: 50, selected: [{ x: 7, y: 4 }], dryRun: true, clientRequestId: "batch-protected-01" });
  check("explicit footprint selection rejects protected owned tiles deterministically", batchResult.response.status === 409 && batchResult.data.error === "selection_protected", JSON.stringify(batchResult.data));
  batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: 50, selected: [{ x: 7, y: 7 }], dryRun: true, clientRequestId: "batch-stale-0001" });
  check("explicit footprint selection rejects stale empty coordinates deterministically", batchResult.response.status === 409 && batchResult.data.error === "selection_stale", JSON.stringify(batchResult.data));

  const explicitSelection = [{ x: 1, y: 0 }, { x: 0, y: 0 }];
  let batchDry = await batchReset({ id: batchPlanId, version: 1, boardVersion: 50, selected: explicitSelection, dryRun: true, clientRequestId: "batch-explicit-001" });
  check("explicit dry-run canonicalizes and binds only the requested eligible tiles", batchDry.response.ok && batchDry.data.footprint?.selectedCount === 2 && batchDry.data.footprint?.selected?.[0]?.x === 0 && batchDry.data.footprint?.remainingCount === 37, JSON.stringify(batchDry.data));
  batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: 50, selected: [{ x: 0, y: 0 }, { x: 2, y: 0 }], footprintHash: batchDry.data.footprint?.hash, dryRun: false, confirmationId: batchDry.data.confirmationId, clientRequestId: "batch-explicit-001" });
  check("confirmation rejects an altered explicit selection binding", batchResult.response.status === 409 && batchResult.data.error === "footprint_confirmation_required", JSON.stringify(batchResult.data));
  batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: 50, selected: explicitSelection, footprintHash: batchDry.data.footprint?.hash, dryRun: false, confirmationId: batchDry.data.confirmationId, clientRequestId: "batch-explicit-001" });
  check("exact explicit confirmation clears and credits only the selected tiles", batchResult.response.ok && batchResult.data.clearedCount === 2 && batchResult.data.relocationCredit?.amount === 2 && batchResult.data.relocationCredit?.balanceAfter === 2, JSON.stringify(batchResult.data));

  await batchStorage.delete("protection:cell:7:4");
  batchDry = await batchReset({ id: batchPlanId, version: 1, boardVersion: batchResult.data.boardVersion, dryRun: true, clientRequestId: "batch-all-first-01" });
  check("all-owned dry-run returns one bounded batch plus continuation", batchDry.response.ok && batchDry.data.footprint?.selectedCount === 32 && batchDry.data.footprint?.remainingCount === 6 && typeof batchDry.data.footprint?.nextCursor === "string", JSON.stringify(batchDry.data));
  batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: batchResult.data.boardVersion, footprintHash: batchDry.data.footprint?.hash, dryRun: false, confirmationId: batchDry.data.confirmationId, clientRequestId: "batch-all-first-01" });
  check("first continuation batch clears at most the fixed transaction bound", batchResult.response.ok && batchResult.data.clearedCount === 32 && batchResult.data.remainingCount === 6 && batchResult.data.relocationCredit?.balanceAfter === 34, JSON.stringify(batchResult.data));
  const continuationCursor = batchResult.data.nextCursor;
  batchDry = await batchReset({ id: batchPlanId, version: 1, boardVersion: batchResult.data.boardVersion, cursor: continuationCursor, dryRun: true, clientRequestId: "batch-all-final-01" });
  batchResult = await batchReset({ id: batchPlanId, version: 1, boardVersion: batchResult.data.boardVersion, cursor: continuationCursor, footprintHash: batchDry.data.footprint?.hash, dryRun: false, confirmationId: batchDry.data.confirmationId, clientRequestId: "batch-all-final-01" });
  const batchBalance = await batchStorage.get(`relocationcredits:${owner}`);
  const batchStatAfter = await batchStorage.get(`agent:${owner}`);
  const batchMetaAfter = await batchStorage.get("meta");
  check(
    "continuation clears every eligible owned tile with exact aggregate credit and zero reward inflation",
    batchResult.response.ok
      && batchResult.data.clearedCount === 6
      && batchResult.data.remainingCount === 0
      && batchResult.data.nextCursor === null
      && Array.isArray(batchBalance) && batchBalance.length === 1 && batchBalance[0]?.amount === 40
      && batchStatAfter?.bonusTiles === 0 && batchStatAfter?.placements === 40 && batchStatAfter?.reputation === 40
      && batchMetaAfter?.totalPlacements === 41
      && new Uint8Array(await batchStorage.get("board")).filter((value) => value === 6).length === 0
      && new Uint8Array(await batchStorage.get("board"))[foreignCoordinate.y * size + foreignCoordinate.x] === 10
      && await batchStorage.get(`reclaim:event:${batchEpoch}:${griefEventId}`) !== undefined,
    JSON.stringify({ result: batchResult.data, balance: batchBalance, stat: batchStatAfter, meta: batchMetaAfter })
  );
  const finalReplay = await batchReset({ id: batchPlanId, version: 1, boardVersion: batchDry.data.boardVersion, cursor: continuationCursor, footprintHash: batchDry.data.footprint?.hash, dryRun: false, confirmationId: batchDry.data.confirmationId, clientRequestId: "batch-all-final-01" });
  check("final continuation replay cannot duplicate clears or relocation credit", finalReplay.response.ok && finalReplay.data.already === true && (await batchStorage.get(`relocationcredits:${owner}`))?.[0]?.amount === 40, JSON.stringify(finalReplay.data));

  const resetResponse = await canvas.handleReset(new Request("https://test/internal/reset", { method: "POST", headers: { Authorization: "Bearer test-reset", "Content-Type": "application/json" }, body: "{}" }), "*");
  check("reset advances the epoch and cleans bounded reclaim state", resetResponse.ok && (await storage.list({ prefix: "reclaim:" })).size === 0, await resetResponse.text());
} finally {
  Date.now = realNow;
}

process.exitCode = failed ? 1 : 0;
