#!/usr/bin/env node
import { GrokPlaceCanvas } from "../worker/index.js";

class TransactionalMemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
    this.currentTransaction = 0;
    this.nextTransaction = 1;
    this.transactionWrites = [];
    this.tail = Promise.resolve();
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
    const transaction = this.nextTransaction++;
    this.currentTransaction = transaction;
    const store = {
      get: (key) => this.get(key),
      put: (key, value) => this.put(key, value),
      delete: (key) => this.delete(key),
    };
    try {
      return await callback(store);
    } finally {
      this.currentTransaction = 0;
      release();
    }
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
  provenance: Array.from({ length: size * size }, () => null),
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

try {
  let result = await protect({ agent: "protector", x: 1, y: 1, action: "protect", clientRequestId: "protect-cell-1" });
  const firstProtection = await storage.get("protection:cell:9");
  const firstTurn = await storage.get("turn:protector");
  const committed = storage.transactionWrites.filter((write) => ["protection:cell:9", "protection:request:protector:protect-cell-1", "turn:protector"].includes(write.key));
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
      && (await storage.get("protection:cell:10")) === undefined,
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
  const raceRecord = await storage.get("protection:cell:10");
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
      && (await storage.get("protection:cell:11")) === undefined,
    JSON.stringify({ response: result.data, turn: await storage.get("turn:overwriter"), board: boardAfterOverwrite[11] })
  );

  result = await protect({ agent: "after-expiry", x: 4, y: 1, action: "protect", clientRequestId: "expiry-protection" });
  const expiresAt = result.data.protection?.expiresAt;
  now = Number(expiresAt) + 1;
  result = await place({ agent: "after-expiry", goal: "after expiry", x: 4, y: 1, color: 10 });
  check(
    "expired protection is cleared lazily and ordinary placement succeeds after expiry",
    result.response.status === 200
      && (await storage.get("protection:cell:12")) === undefined
      && new Uint8Array(await storage.get("board"))[12] === 11,
    JSON.stringify({ response: result.data, protection: await storage.get("protection:cell:12") })
  );
} finally {
  Date.now = realNow;
}

process.exitCode = failed ? 1 : 0;
