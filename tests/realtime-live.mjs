#!/usr/bin/env node
import worker, { GrokPlaceCanvas } from "../worker/index.js";

class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
    this.alarmAt = null;
    this.insideTransaction = false;
    this.topLevelCallsInsideTransaction = 0;
  }
  async get(key) { if (this.insideTransaction) this.topLevelCallsInsideTransaction++; return this.values.get(key); }
  async put(key, value) {
    if (this.insideTransaction) this.topLevelCallsInsideTransaction++;
    if (typeof key === "object" && key !== null) for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async delete(key) { if (this.insideTransaction) this.topLevelCallsInsideTransaction++; this.values.delete(key); }
  async setAlarm(at) { if (this.insideTransaction) this.topLevelCallsInsideTransaction++; this.alarmAt = at; }
  async getAlarm() { if (this.insideTransaction) this.topLevelCallsInsideTransaction++; return this.alarmAt; }
  async deleteAlarm() { if (this.insideTransaction) this.topLevelCallsInsideTransaction++; this.alarmAt = null; }
  async transaction(callback) {
    const txn = {
      get: async (key) => this.values.get(key),
      put: async (key, value) => {
        if (typeof key === "object" && key !== null) for (const [name, item] of Object.entries(key)) this.values.set(name, item);
        else this.values.set(key, value);
      },
      delete: async (key) => { this.values.delete(key); },
      getAlarm: async () => this.alarmAt,
      setAlarm: async (at) => { this.alarmAt = at; },
      deleteAlarm: async () => { this.alarmAt = null; },
    };
    this.insideTransaction = true;
    try { return await callback(txn); }
    finally { this.insideTransaction = false; }
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

{
  let routed = false;
  const env = {
    CANVAS: {
      idFromName() { routed = true; return "main"; },
      get() { routed = true; throw new Error("must not route an invalid websocket request"); },
    },
  };
  const response = await worker.fetch(new Request("https://test/v1/live"), env);
  const data = await response.json();
  check("public live endpoint rejects a missing websocket upgrade before the DO", response.status === 426 && data.error === "websocket_upgrade_required" && !routed, JSON.stringify(data));
}

{
  let forwarded = null;
  const env = {
    CANVAS: {
      idFromName() { return "main"; },
      get() {
        return {
          fetch(url, init) {
            forwarded = { url, headers: new Headers(init.headers) };
            return new Response(null, { status: 200 });
          },
        };
      },
    },
  };
  const secret = "gp_a_" + "b".repeat(64);
  const response = await worker.fetch(new Request("https://test/v1/live", {
    headers: { Upgrade: "websocket", Origin: "https://viewer.test", Authorization: `Agent ${secret}`, Cookie: "session=private", "X-Agent-Name": "viewer" },
  }), env);
  check("valid public websocket upgrades forward to the single internal live route", response.status === 200 && new URL(forwarded?.url || "https://test").pathname === "/internal/live", JSON.stringify({ status: response.status, url: forwarded?.url }));
  check("live forwarding carries only minimal websocket negotiation headers", JSON.stringify([...((forwarded?.headers) || new Headers()).entries()].sort()) === JSON.stringify([["origin", "https://viewer.test"], ["upgrade", "websocket"]]), JSON.stringify([...((forwarded?.headers) || new Headers())]));
}

const storage = new MemoryStorage({ meta: { version: 23 }, hiddenCapability: "gp_a_" + "a".repeat(64) });
const sent = [];
const closed = [];
const socket = {
  send(message) { sent.push(message); },
  close(code, reason) { closed.push({ code, reason }); },
};
const state = {
  storage,
  getWebSockets() { return [socket]; },
};
const canvas = new GrokPlaceCanvas(state, {});

{
  const response = await canvas.handleLive(new Request("https://test/internal/live"), "*");
  const data = await response.json();
  check("DO also rejects a missing websocket upgrade", response.status === 426 && data.error === "websocket_upgrade_required", JSON.stringify(data));
}

{
  const saturatedCanvas = new GrokPlaceCanvas({
    storage: new MemoryStorage(),
    getWebSockets() { return Array.from({ length: 256 }, () => socket); },
  }, {});
  const response = await saturatedCanvas.handleLive(new Request("https://test/internal/live", { headers: { Upgrade: "websocket" } }), "*");
  const data = await response.json();
  check("live socket cap rejects the 257th connection before acceptance", response.status === 503 && response.headers.get("Retry-After") === "1" && data.error === "live_capacity", JSON.stringify(data));
}

canvas.broadcastLive(["canvas", "activity", "music", "unknown"], 23);
check("live broadcasts use only the bounded typed invalidation payloads", JSON.stringify(sent) === JSON.stringify([
  '{"t":"canvas","v":23}',
  '{"t":"activity","v":23}',
  '{"t":"music","v":23}',
]), JSON.stringify(sent));
check("live broadcasts never leak storage capabilities", !sent.join("\n").includes("gp_a_") && !sent.join("\n").includes("a".repeat(32)), sent.join("\n"));

canvas.webSocketMessage(socket, "{\"place\":\"not a command\"}");
check("client websocket messages are closed instead of treated as commands", closed.some(({ code }) => code === 1008), JSON.stringify(closed));

function song(id, title) {
  return {
    id,
    title,
    submittedBy: "MusicAgent",
    votes: 1,
    voters: ["musicagent"],
    addedAt: 1,
    license: "CC0-1.0",
    originalNonInfringingAttested: true,
    composition: {
      bpm: 180,
      waveform: "sine",
      notes: [{ note: "C4", at: 0, duration: 1, velocity: 0.7 }],
      durationMs: 84,
    },
  };
}

{
  const current = { ...song("current", "Current"), startedAt: 900, endsAt: 1_000, advanceToken: "a".repeat(32) };
  const next = song("next", "Next");
  const alarmStorage = new MemoryStorage({
    music: { now: current, queue: [next], version: 7 },
    musicAlarmTarget: { compositionId: "current", endsAt: 1_000 },
  });
  alarmStorage.alarmAt = 1_000;
  const alarmMessages = [];
  const alarmSocket = { send(message) { alarmMessages.push(message); }, close() {} };
  const alarmCanvas = new GrokPlaceCanvas({ storage: alarmStorage, getWebSockets() { return [alarmSocket]; } }, {});
  const realNow = Date.now;
  Date.now = () => 1_000;
  try {
    await alarmCanvas.alarm();
    const advanced = await alarmStorage.get("music");
    const target = await alarmStorage.get("musicAlarmTarget");
    check("due music alarm promotes the queued shortest composition", advanced.now?.id === "next" && advanced.queue.length === 0 && advanced.now.endsAt === 1_084, JSON.stringify(advanced));
    check("due music alarm broadcasts and atomically schedules the promoted composition", alarmMessages.length === 1 && alarmMessages[0] === '{"t":"music","v":8}' && target?.compositionId === "next" && target.endsAt === 1_084 && alarmStorage.alarmAt === 1_084, JSON.stringify({ alarmMessages, target, alarmAt: alarmStorage.alarmAt }));
    check("music transaction uses only the callback transaction handle", alarmStorage.topLevelCallsInsideTransaction === 0, `topLevelCallsInsideTransaction=${alarmStorage.topLevelCallsInsideTransaction}`);
    const response = await alarmCanvas.handleMusicGet("*");
    const body = await response.json();
    check("the first GET after alarm promotion returns the next composition", body.now?.id === "next" && body.queue.length === 0, JSON.stringify(body));
    await alarmCanvas.alarm();
    check("an at-least-once retry before the new deadline does not skip or duplicate", (await alarmStorage.get("music")).now?.id === "next" && alarmMessages.length === 1, JSON.stringify(alarmMessages));
  } finally {
    Date.now = realNow;
  }
}

{
  const current = { ...song("still-current", "Still current"), startedAt: 1_000, endsAt: 2_000, advanceToken: "b".repeat(32) };
  const queued = song("queued", "Queued");
  const earlyStorage = new MemoryStorage({
    music: { now: current, queue: [queued], version: 3 },
    musicAlarmTarget: { compositionId: "still-current", endsAt: 2_000 },
  });
  const earlyMessages = [];
  const earlyCanvas = new GrokPlaceCanvas({ storage: earlyStorage, getWebSockets() { return [{ send(message) { earlyMessages.push(message); } }]; } }, {});
  const realNow = Date.now;
  Date.now = () => 1_500;
  try {
    await earlyCanvas.alarm();
  } finally {
    Date.now = realNow;
  }
  check("an early alarm only restores the exact current deadline", (await earlyStorage.get("music")).now?.id === "still-current" && earlyStorage.alarmAt === 2_000 && earlyMessages.length === 0, JSON.stringify({ alarmAt: earlyStorage.alarmAt, earlyMessages }));
}

{
  const current = { ...song("replacement", "Replacement"), startedAt: 1_000, endsAt: 2_000, advanceToken: "c".repeat(32) };
  const queued = song("must-not-skip", "Must not skip");
  const staleStorage = new MemoryStorage({
    music: { now: current, queue: [queued], version: 4 },
    musicAlarmTarget: { compositionId: "removed", endsAt: 1_200 },
  });
  staleStorage.alarmAt = null;
  const staleMessages = [];
  const staleCanvas = new GrokPlaceCanvas({ storage: staleStorage, getWebSockets() { return [{ send(message) { staleMessages.push(message); } }]; } }, {});
  const realNow = Date.now;
  Date.now = () => 1_500;
  try {
    await staleCanvas.alarm();
  } finally {
    Date.now = realNow;
  }
  const repaired = await staleStorage.get("musicAlarmTarget");
  check("a stale alarm cannot skip the persisted replacement", (await staleStorage.get("music")).now?.id === "replacement" && repaired?.compositionId === "replacement" && repaired.endsAt === 2_000 && staleStorage.alarmAt === 2_000 && staleMessages.length === 0, JSON.stringify({ repaired, alarmAt: staleStorage.alarmAt, staleMessages }));
}

const accepted = [];
const previousWebSocketPair = globalThis.WebSocketPair;
const previousResponse = globalThis.Response;
globalThis.WebSocketPair = class {
  constructor() {
    this.client = { kind: "client" };
    this.server = { send() {}, close() {} };
  }
};
globalThis.Response = function ResponseMock(body, init = {}) {
  if (init.status === 101) return { status: 101, headers: new Headers(init.headers), webSocket: init.webSocket };
  return new previousResponse(body, init);
};
try {
  const liveState = {
    storage: new MemoryStorage({ meta: { version: 9 } }),
    acceptWebSocket(server) { accepted.push(server); },
    getWebSockets() { return []; },
  };
  const liveCanvas = new GrokPlaceCanvas(liveState, {});
  const response = await liveCanvas.handleLive(new Request("https://test/internal/live", { headers: { Upgrade: "websocket" } }), "*");
  check("WebSocketPair upgrade accepts the server socket", response.status === 101 && accepted.length === 1, `status=${response.status} accepted=${accepted.length}`);
} finally {
  if (previousWebSocketPair) globalThis.WebSocketPair = previousWebSocketPair;
  else delete globalThis.WebSocketPair;
  globalThis.Response = previousResponse;
}

process.exitCode = failed ? 1 : 0;
