#!/usr/bin/env node
import { GrokPlaceCanvas } from "../worker/index.js";

class TransactionalMemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
    this.currentTransaction = 0;
    this.nextTransaction = 1;
    this.transactionWrites = [];
    this.tail = Promise.resolve();
    this.nextGate = null;
  }

  async get(key) { return this.values.get(key); }

  async put(key, value) {
    if (typeof key === "object" && key !== null) {
      for (const [name, item] of Object.entries(key)) this.write(name, item);
      return;
    }
    this.write(key, value);
  }

  async delete(key) { this.values.delete(key); }

  write(key, value) {
    this.values.set(key, value);
    if (this.currentTransaction) this.transactionWrites.push({ transaction: this.currentTransaction, key });
  }

  async list({ prefix = "", limit = 1_000 } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }

  async transaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const gate = this.nextGate;
    this.nextGate = null;
    if (gate) {
      gate.entered();
      await gate.release;
    }
    const transaction = this.nextTransaction++;
    this.currentTransaction = transaction;
    const store = {
      get: (key) => this.get(key),
      put: (key, value) => this.put(key, value),
      delete: (key) => this.delete(key),
      list: (options) => this.list(options),
    };
    try {
      return await callback(store);
    } finally {
      this.currentTransaction = 0;
      release();
    }
  }

  holdNextTransaction() {
    let entered;
    let release;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const releasePromise = new Promise((resolve) => { release = resolve; });
    this.nextGate = { entered, release: releasePromise };
    return { entered: enteredPromise, release };
  }
}

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const size = 8;
const board = new Uint8Array(size * size);
for (const [x, y, color] of [[1, 1, 5], [2, 1, 6], [3, 1, 7], [4, 1, 8]]) board[y * size + x] = color + 1;
const storage = new TransactionalMemoryStorage({
  board: board.buffer,
  scores: new Int16Array(size * size).buffer,
  size,
  schema: 4,
  meta: { version: 0, totalPlacements: 4, totalVotes: 0, uniqueAgents: 1, lastPlaceAt: 0 },
  feed: [],
  history: [],
  leaders: [],
  "turn:protector": { left: 5, nextTurnAt: 0 },
  "turn:racer": { left: 5, nextTurnAt: 0 },
  "turn:overwriter": { left: 5, nextTurnAt: 0 },
  "turn:after-expiry": { left: 5, nextTurnAt: 0 },
});
const canvas = new GrokPlaceCanvas({ storage, getWebSockets() { return []; } }, {});
canvas.rateLimit = async () => ({ ok: true });
canvas.consumeProof = async () => ({ ok: true });
canvas.requireAgentCapability = async () => ({ ok: true });

let now = 1_000;
const realNow = Date.now;
Date.now = () => now;

async function protect(body) {
  const request = new Request("https://test/internal/protect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await canvas.handleProtect(request, size, 60_000, "*", "test-ip");
  return { response, data: await response.json() };
}

async function place(body) {
  const request = new Request("https://test/internal/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await canvas.handlePlace(request, size, 60_000, "*", "test-ip");
  return { response, data: await response.json() };
}

async function voteOn(targetCanvas, body, targetSize = size) {
  const request = new Request("https://test/internal/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await targetCanvas.handleVote(request, targetSize, "*", "test-ip");
  return { response, data: await response.json() };
}

async function reportOn(targetCanvas, body, targetSize = size) {
  const request = new Request("https://test/internal/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await targetCanvas.handleReport(request, targetSize, "*", "test-ip");
  return { response, data: await response.json() };
}

try {
  let result = await protect({ agent: "protector", x: 1, y: 1, action: "protect", clientRequestId: "protect-cell-1" });
  const firstProtection = await storage.get("protection:cell:1:1");
  const firstTurn = await storage.get("turn:protector");
  const committed = storage.transactionWrites.filter((write) => ["protection:cell:1:1", "protection:requests:protector", "turn:protector"].includes(write.key));
  check(
    "a successful protection atomically spends exactly three current turn credits",
    result.response.status === 200
      && result.data.spentCredits === 3
      && result.data.chargedCredits === 3
      && firstTurn.left === 2
      && firstProtection?.expiresAt === now + 15 * 60_000
      && new Set(committed.map((write) => write.transaction)).size === 1,
    JSON.stringify({ response: result.data, firstTurn, firstProtection, committed })
  );

  result = await protect({ agent: "protector", x: 1, y: 1, action: "protect", clientRequestId: "protect-cell-1" });
  check(
    "an exact replay returns the durable result without a second debit",
    result.response.status === 200
      && result.data.replayed === true
      && result.data.chargedCredits === 0
      && (await storage.get("turn:protector")).left === 2,
    JSON.stringify({ response: result.data, turn: await storage.get("turn:protector") })
  );

  result = await protect({ agent: "protector", x: 2, y: 1, action: "protect", clientRequestId: "insufficient-credits" });
  check(
    "insufficient credits fail without a debit or a protection record",
    result.response.status === 409
      && result.data.error === "insufficient_protection_credits"
      && (await storage.get("turn:protector")).left === 2
      && (await storage.get("protection:cell:2:1")) === undefined,
    JSON.stringify({ response: result.data, turn: await storage.get("turn:protector") })
  );

  result = await protect({ agent: "protector", x: 1, y: 1, action: "protect", clientRequestId: "existing-protection" });
  check(
    "an already protected tile fails without spending credits",
    result.response.status === 409
      && result.data.error === "already_protected"
      && (await storage.get("turn:protector")).left === 2,
    JSON.stringify({ response: result.data, turn: await storage.get("turn:protector") })
  );

  const raced = await Promise.all([
    protect({ agent: "racer", x: 3, y: 1, action: "protect", clientRequestId: "race-request-a" }),
    protect({ agent: "racer", x: 3, y: 1, action: "protect", clientRequestId: "race-request-b" }),
  ]);
  const raceErrors = raced.map((item) => item.data.error).filter(Boolean);
  check(
    "concurrent protection attempts serialize so only one can spend",
    raced.filter((item) => item.response.status === 200).length === 1
      && raceErrors.length === 1
      && raceErrors[0] === "already_protected"
      && (await storage.get("turn:racer")).left === 2,
    JSON.stringify({ raced: raced.map((item) => item.data), turn: await storage.get("turn:racer") })
  );

  const [raceProtection, racePlace] = await Promise.all([
    protect({ agent: "race-protector", x: 2, y: 1, action: "protect", clientRequestId: "cross-route-race" }),
    place({ agent: "race-place", goal: "ordinary race", x: 2, y: 1, color: 9 }),
  ]);
  const raceBoard = new Uint8Array(await storage.get("board"));
  const raceRecord = await storage.get("protection:cell:2:1");
  const placeFinishedFirst = racePlace.response.status === 200
    && raceProtection.response.status === 200
    && raceRecord?.colorIndex != null
    && raceBoard[10] === raceRecord.colorIndex + 1;
  const protectionFinishedFirst = raceProtection.response.status === 200
    && racePlace.response.status === 409
    && racePlace.data.error === "protected_tile";
  check(
    "protection and ordinary placement cannot race into an unprotected overwrite",
    placeFinishedFirst || protectionFinishedFirst,
    JSON.stringify({ protection: raceProtection.data, place: racePlace.data, board: raceBoard[10], record: raceRecord })
  );

  result = await place({ agent: "overwriter", goal: "replace protected tile", x: 3, y: 1, color: 9 });
  check(
    "ordinary placement returns the stable protected_tile error without a debit",
    result.response.status === 409
      && result.data.error === "protected_tile"
      && result.data.reason === "active_protection"
      && (await storage.get("turn:overwriter")).left === 5,
    JSON.stringify({ response: result.data, turn: await storage.get("turn:overwriter") })
  );

  result = await protect({ agent: "overwriter", x: 3, y: 1, action: "overwrite", color: 9, clientRequestId: "paid-overwrite" });
  const boardAfterOverwrite = new Uint8Array(await storage.get("board"));
  check(
    "the documented paid overwrite is the only early replacement path and costs three credits",
    result.response.status === 200
      && result.data.spentCredits === 3
      && (await storage.get("turn:overwriter")).left === 2
      && boardAfterOverwrite[11] === 10
      && (await storage.get("protection:cell:3:1")) === undefined,
    JSON.stringify({ response: result.data, turn: await storage.get("turn:overwriter"), board: boardAfterOverwrite[11] })
  );

  result = await protect({ agent: "after-expiry", x: 4, y: 1, action: "protect", clientRequestId: "expiry-protection" });
  const expiresAt = result.data.protection?.expiresAt;
  now = Number(expiresAt) + 1;
  result = await place({ agent: "after-expiry", goal: "after expiry", x: 4, y: 1, color: 10 });
  check(
    "expired protection is cleared lazily and ordinary placement succeeds after expiry",
    result.response.status === 200
      && (await storage.get("protection:cell:4:1")) === undefined
      && new Uint8Array(await storage.get("board"))[12] === 11,
    JSON.stringify({ response: result.data, protection: await storage.get("protection:cell:4:1") })
  );

  let boundedOk = true;
  for (let index = 0; index < 34; index++) {
    await storage.put("turn:bounded", { left: 5, nextTurnAt: 0 });
    now += 1;
    const action = index % 2 === 0 ? "protect" : "overwrite";
    const attempt = await protect({
      agent: "bounded",
      x: 4,
      y: 1,
      action,
      ...(action === "overwrite" ? { color: (index % 15) + 1 } : {}),
      clientRequestId: `bounded-${String(index).padStart(3, "0")}`,
    });
    if (attempt.response.status !== 200) boundedOk = false;
  }
  const replayLog = await storage.get("protection:requests:bounded");
  check(
    "protection idempotency uses one bounded replay ring per agent",
    boundedOk
      && Array.isArray(replayLog)
      && replayLog.length === 32
      && replayLog[0]?.clientRequestId === "bounded-033"
      && !replayLog.some((record) => record.clientRequestId === "bounded-000"),
    JSON.stringify(replayLog)
  );

  const capacitySize = 16;
  const capacityBoard = new Uint8Array(capacitySize * capacitySize).fill(2);
  const capacityValues = {
    board: capacityBoard.buffer,
    scores: new Int16Array(capacitySize * capacitySize).buffer,
    size: capacitySize,
    schema: 4,
    meta: { version: 0, totalPlacements: 256, totalVotes: 0, uniqueAgents: 1, lastPlaceAt: now },
    feed: [],
    history: [],
    leaders: [],
    "turn:capacity": { left: 5, nextTurnAt: 0 },
  };
  for (let index = 0; index < 120; index++) {
    const x = index % capacitySize;
    const y = Math.floor(index / capacitySize);
    capacityValues[`protection:cell:${x}:${y}`] = {
      version: 1,
      x,
      y,
      colorIndex: 1,
      color: "#E4E4E4",
      protector: "capacity",
      protectedAt: now,
      expiresAt: now + 60_000,
    };
  }
  const capacityStorage = new TransactionalMemoryStorage(capacityValues);
  const capacityCanvas = new GrokPlaceCanvas({ storage: capacityStorage, getWebSockets() { return []; } }, {});
  capacityCanvas.rateLimit = async () => ({ ok: true });
  capacityCanvas.consumeProof = async () => ({ ok: true });
  capacityCanvas.requireAgentCapability = async () => ({ ok: true });
  const capacityResponse = await capacityCanvas.handleProtect(new Request("https://test/internal/protect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "capacity", x: 15, y: 15, action: "protect", clientRequestId: "capacity-full" }),
  }), capacitySize, 60_000, "*", "test-ip");
  const capacityData = await capacityResponse.json();
  check(
    "the active protection cap rejects new records before spending credits",
    capacityResponse.status === 429
      && capacityData.error === "protection_capacity"
      && (await capacityStorage.get("turn:capacity")).left === 5
      && (await capacityStorage.get("protection:cell:15:15")) === undefined,
    JSON.stringify({ response: capacityData, turn: await capacityStorage.get("turn:capacity") })
  );

  const growthBoard = new Uint8Array(size * size);
  growthBoard[1 * size + 1] = 6;
  const growthStorage = new TransactionalMemoryStorage({
    board: growthBoard.buffer,
    scores: new Int16Array(size * size).buffer,
    size,
    schema: 4,
    meta: { version: 1, totalPlacements: 1, totalVotes: 0, uniqueAgents: 1, lastPlaceAt: now },
    feed: [],
    history: [],
    leaders: [],
    "turn:growth-overwriter": { left: 5, nextTurnAt: 0 },
    "protection:cell:1:1": {
      version: 1,
      x: 1,
      y: 1,
      colorIndex: 5,
      color: "#E50000",
      protector: "protector",
      protectedAt: now,
      expiresAt: now + 60_000,
    },
  });
  const growthCanvas = new GrokPlaceCanvas({ storage: growthStorage, getWebSockets() { return []; } }, {});
  growthCanvas.rateLimit = async () => ({ ok: true });
  growthCanvas.consumeProof = async () => ({ ok: true });
  growthCanvas.requireAgentCapability = async () => ({ ok: true });
  await growthCanvas.handleCanvas(new URL("https://test/internal/canvas"), 16, "*");
  const growthResponse = await growthCanvas.handlePlace(new Request("https://test/internal/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "growth-overwriter", goal: "try protected growth tile", x: 1, y: 1, color: 9 }),
  }), 16, 60_000, "*", "test-ip");
  const growthData = await growthResponse.json();
  check(
    "coordinate-keyed protection remains enforceable after canvas growth",
    growthResponse.status === 409
      && growthData.error === "protected_tile"
      && (await growthStorage.get("protection:cell:1:1"))?.colorIndex === 5
      && new Uint8Array(await growthStorage.get("board"))[17] === 6,
    JSON.stringify({ response: growthData, protection: await growthStorage.get("protection:cell:1:1") })
  );

  const mutationBoard = new Uint8Array(size * size);
  mutationBoard[0] = 6;
  mutationBoard[1] = 7;
  const mutationValues = {
    board: mutationBoard.buffer,
    scores: new Int16Array(size * size).buffer,
    size,
    schema: 4,
    meta: { version: 1, tileEpoch: 1, totalPlacements: 2, totalVotes: 0, totalReportsCleared: 0, uniqueAgents: 1, lastPlaceAt: now },
    feed: [],
    history: [],
    leaders: [],
    "owner:cell:0:0": "artist",
    "owner:cell:1:0": "artist",
    "agent:artist": { name: "artist", placements: 2, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 2, firstAt: now, lastAt: now },
  };
  for (const agent of ["voter-a", "voter-b", "duplicate-voter", "reporter-a", "reporter-b", "reporter-c"]) {
    mutationValues[`agent:${agent}`] = { name: agent, placements: 1, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 1, firstAt: now, lastAt: now };
  }
  const mutationStorage = new TransactionalMemoryStorage(mutationValues);
  const mutationCanvas = new GrokPlaceCanvas({ storage: mutationStorage, getWebSockets() { return []; } }, {});
  mutationCanvas.rateLimit = async () => ({ ok: true });
  mutationCanvas.consumeProof = async () => ({ ok: true });
  mutationCanvas.requireAgentCapability = async () => ({ ok: true });

  const distinctVotes = await Promise.all([
    voteOn(mutationCanvas, { agent: "voter-a", x: 0, y: 0, dir: 1 }),
    voteOn(mutationCanvas, { agent: "voter-b", x: 0, y: 0, dir: 1 }),
  ]);
  check(
    "concurrent votes from distinct agents serialize without lost counters",
    distinctVotes.every((item) => item.response.status === 200)
      && new Int16Array(await mutationStorage.get("scores"))[0] === 2
      && (await mutationStorage.get("meta"))?.totalVotes === 2
      && (await mutationStorage.get("agent:artist"))?.upvotesReceived === 2,
    JSON.stringify({ votes: distinctVotes.map((item) => item.data), meta: await mutationStorage.get("meta"), owner: await mutationStorage.get("agent:artist") })
  );

  const duplicateVotes = await Promise.all([
    voteOn(mutationCanvas, { agent: "duplicate-voter", x: 0, y: 0, dir: 1 }),
    voteOn(mutationCanvas, { agent: "duplicate-voter", x: 0, y: 0, dir: 1 }),
  ]);
  check(
    "concurrent duplicate votes from one agent count exactly once",
    duplicateVotes.filter((item) => item.response.status === 200).length === 1
      && duplicateVotes.filter((item) => item.data.error === "cooldown" || item.data.error === "already_voted").length === 1
      && new Int16Array(await mutationStorage.get("scores"))[0] === 3
      && (await mutationStorage.get("meta"))?.totalVotes === 3,
    JSON.stringify(duplicateVotes.map((item) => item.data))
  );

  const reports = await Promise.all([
    reportOn(mutationCanvas, { agent: "reporter-a", x: 1, y: 0, reason: "unsafe" }),
    reportOn(mutationCanvas, { agent: "reporter-b", x: 1, y: 0, reason: "unsafe" }),
    reportOn(mutationCanvas, { agent: "reporter-c", x: 1, y: 0, reason: "unsafe" }),
  ]);
  const clears = (await mutationStorage.get("history") || []).filter((entry) => entry?.type === "clear" && entry.x === 1 && entry.y === 0);
  check(
    "three concurrent unique reports clear the tile exactly once",
    reports.every((item) => item.response.status === 200)
      && reports.filter((item) => item.data.report?.cleared).length === 1
      && new Uint8Array(await mutationStorage.get("board"))[1] === 0
      && new Int16Array(await mutationStorage.get("scores"))[1] === 0
      && (await mutationStorage.get("meta"))?.totalReportsCleared === 1
      && clears.length === 1,
    JSON.stringify({ reports: reports.map((item) => item.data), meta: await mutationStorage.get("meta"), clears })
  );

  const racePlanId = "pl_cccccccccccccccc";
  const racePlan = {
    id: racePlanId, agent: "plan-racer", clientRequestId: "plan-race-create", title: "Serialized plan",
    summary: "A bounded concurrency fixture.", region: "top left", bounds: { x: 0, y: 0, w: 2, h: 2 },
    steps: [{ n: 1, text: "Place one tile", done: false }], design: { w: 4, h: 4, cells: [{ x: 0, y: 0, c: 5, color: "#E50000" }] },
    tileBudget: 2, estimatedTurns: 1, status: "active", ownerConsentAttestedByAgent: true, attestedAt: now,
    progress: { notes: "" }, acceptedPlacements: 0, assignments: [], version: 1, activatedVersion: 1,
    acceptedReviewId: "pvr_cccccccccccccccc", createdAt: now, updatedAt: now,
  };
  const planRaceStorage = new TransactionalMemoryStorage({
    board: new Uint8Array(size * size).buffer, scores: new Int16Array(size * size).buffer, size, schema: 4,
    meta: { version: 0, tileEpoch: 1, totalPlacements: 0, totalVotes: 0, uniqueAgents: 1, lastPlaceAt: now }, feed: [], history: [], leaders: [],
    [`plan:${racePlanId}`]: racePlan, [`planrev:${racePlanId}:1`]: { ...racePlan }, [`planrevs:${racePlanId}`]: [1],
    planIndex: [{ id: racePlanId, agent: "plan-racer", updatedAt: now, status: "active", bounds: racePlan.bounds }],
    "agent:plan-racer": { name: "plan-racer", placements: 1, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 1, firstAt: now, lastAt: now, activePlanId: racePlanId, joinedPlanIds: [], avoidedPlanIds: [] },
    "turn:plan-racer": { left: 5, nextTurnAt: 0 },
  });
  const planRaceCanvas = new GrokPlaceCanvas({ storage: planRaceStorage, getWebSockets() { return []; } }, {});
  planRaceCanvas.rateLimit = async () => ({ ok: true });
  planRaceCanvas.consumeProof = async () => ({ ok: true });
  planRaceCanvas.requireAgentCapability = async () => ({ ok: true });
  const gate = planRaceStorage.holdNextTransaction();
  const placementRequest = new Request("https://test/internal/place", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "plan-racer", goal: "serialized plan", planId: racePlanId, x: 0, y: 0, color: 5 }),
  });
  const placementPromise = planRaceCanvas.handlePlace(placementRequest, size, 60_000, "*", "test-ip");
  const gateResult = await Promise.race([
    gate.entered.then(() => ({ entered: true })),
    placementPromise.then(async (earlyResponse) => ({ entered: false, status: earlyResponse.status, data: await earlyResponse.clone().json() })),
  ]);
  if (!gateResult.entered) throw new Error(`plan race placement did not reach transaction: ${JSON.stringify(gateResult)}`);
  const revisionResponse = await planRaceCanvas.handlePlanSave(new Request("https://test/internal/plan", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: "plan-racer", id: racePlanId, expectedVersion: 1, title: "Serialized plan revised",
      summary: racePlan.summary, region: racePlan.region, bounds: racePlan.bounds, steps: racePlan.steps,
      design: racePlan.design, tileBudget: racePlan.tileBudget, estimatedTurns: racePlan.estimatedTurns,
      status: "proposed", progress: { notes: "revision wins" }, challengeId: "test", nonce: 0,
    }),
  }), "*", "test-ip");
  gate.release();
  const placementResponse = await placementPromise;
  const placementData = await placementResponse.json();
  check(
    "an in-flight plan placement cannot overwrite a concurrently committed revision",
    revisionResponse.status === 200
      && placementResponse.status === 409
      && placementData.error === "plan_changed_retry"
      && (await planRaceStorage.get(`plan:${racePlanId}`))?.version === 2
      && (await planRaceStorage.get(`plan:${racePlanId}`))?.status === "proposed"
      && new Uint8Array(await planRaceStorage.get("board"))[0] === 0,
    JSON.stringify({ revision: await revisionResponse.json(), placement: placementData, plan: await planRaceStorage.get(`plan:${racePlanId}`) })
  );

  async function checkPlanInvalidationRace(name, idDigit, mutatePlan, verifyPlan) {
    const id = `pl_${idDigit.repeat(16)}`;
    const fixturePlan = { ...racePlan, id, clientRequestId: `plan-race-${idDigit}`, acceptedReviewId: `pvr_${idDigit.repeat(16)}` };
    const raceStorage = new TransactionalMemoryStorage({
      board: new Uint8Array(size * size).buffer, scores: new Int16Array(size * size).buffer, size, schema: 4,
      meta: { version: 0, tileEpoch: 1, totalPlacements: 0, totalVotes: 0, uniqueAgents: 1, lastPlaceAt: now }, feed: [], history: [], leaders: [],
      [`plan:${id}`]: fixturePlan,
      planIndex: [{ id, agent: "plan-racer", updatedAt: now, status: "active", bounds: fixturePlan.bounds }],
      "agent:plan-racer": { name: "plan-racer", placements: 1, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 1, firstAt: now, lastAt: now, activePlanId: id, joinedPlanIds: [], avoidedPlanIds: [] },
      "turn:plan-racer": { left: 5, nextTurnAt: 0 },
    });
    const raceCanvas = new GrokPlaceCanvas({ storage: raceStorage, getWebSockets() { return []; } }, {});
    raceCanvas.rateLimit = async () => ({ ok: true });
    raceCanvas.consumeProof = async () => ({ ok: true });
    raceCanvas.requireAgentCapability = async () => ({ ok: true });
    const raceGate = raceStorage.holdNextTransaction();
    const pendingResponse = raceCanvas.handlePlace(new Request("https://test/internal/place", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "plan-racer", goal: "serialized plan", planId: id, x: 0, y: 0, color: 5 }),
    }), size, 60_000, "*", "test-ip");
    await raceGate.entered;
    const invalidated = mutatePlan({ ...fixturePlan });
    await raceStorage.put(`plan:${id}`, invalidated);
    raceGate.release();
    const raceResponse = await pendingResponse;
    const raceData = await raceResponse.json();
    const finalPlan = await raceStorage.get(`plan:${id}`);
    check(
      name,
      raceResponse.status === 409
        && raceData.error === "plan_changed_retry"
        && new Uint8Array(await raceStorage.get("board"))[0] === 0
        && verifyPlan(finalPlan),
      JSON.stringify({ response: raceData, plan: finalPlan })
    );
  }

  await checkPlanInvalidationRace(
    "an in-flight placement cannot overwrite a concurrent confirmation deactivation",
    "d",
    (current) => ({ ...current, status: "attested", activatedVersion: null, acceptedReviewId: null, updatedAt: now + 1 }),
    (current) => current?.status === "attested" && current?.activatedVersion === null
  );
  await checkPlanInvalidationRace(
    "an in-flight placement cannot overwrite a concurrent owner reset",
    "e",
    (current) => ({ ...current, status: "draft", activatedVersion: null, acceptedReviewId: null, ownerConsentAttestedByAgent: false, updatedAt: now + 1 }),
    (current) => current?.status === "draft" && current?.ownerConsentAttestedByAgent === false
  );
  await checkPlanInvalidationRace(
    "an in-flight unassigned placement cannot bypass a concurrent assignment",
    "f",
    (current) => ({
      ...current,
      assignments: [{ id: "as_ffffffffffff", agent: "plan-racer", bounds: { x: 0, y: 0, w: 1, h: 1 }, cells: [], tileBudget: 1, dependencies: [], completionCondition: "Place the assigned tile", status: "active", acceptedPlacements: 0, createdAt: now, updatedAt: now + 1 }],
      updatedAt: now + 1,
    }),
    (current) => current?.assignments?.[0]?.id === "as_ffffffffffff" && current?.assignments?.[0]?.acceptedPlacements === 0
  );
} finally {
  Date.now = realNow;
}

process.exitCode = failed ? 1 : 0;
