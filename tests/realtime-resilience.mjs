#!/usr/bin/env node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { GrokPlaceCanvas } from "../worker/index.js";

const root = new URL("..", import.meta.url);
const mosaicSource = readFileSync(new URL("../public/mosaic.js", import.meta.url), "utf8");
const radioSource = readFileSync(new URL("../public/radio.js", import.meta.url), "utf8");
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function element(id = "") {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    width: 128,
    height: 128,
    hidden: true,
    style: {},
    textContent: "",
    className: "",
    classList: { toggle(name, force) { const next = force === undefined ? !classes.has(name) : Boolean(force); if (next) classes.add(name); else classes.delete(name); return next; } },
    addEventListener(type, handler) { listeners.set(type, handler); },
    appendChild() {},
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 800 }; },
    getContext() { return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }; },
    querySelector() { return null; },
    setAttribute() {},
    getAttribute() { return null; },
    setPointerCapture() {},
    focus() { this.focused = true; },
    _listeners: listeners,
  };
}

class CustomEventMock {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}

function emit(listeners, type, event = {}) {
  for (const handler of listeners.get(type) || []) handler(event);
}

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const setTimeout = (callback, delay = 0) => {
    const id = nextId++;
    jobs.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  const clearTimeout = (id) => jobs.delete(id);
  async function tick(ms) {
    const target = now + ms;
    while (true) {
      let id = 0;
      let next = null;
      for (const [candidateId, job] of jobs) {
        if (job.at <= target && (!next || job.at < next.at || job.at === next.at && candidateId < id)) {
          id = candidateId;
          next = job;
        }
      }
      if (!next) break;
      now = next.at;
      jobs.delete(id);
      next.callback();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    now = target;
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  return {
    setTimeout,
    clearTimeout,
    tick,
    count() { return jobs.size; },
    delays() { return [...jobs.values()].map((job) => job.at - now).sort((a, b) => a - b); },
    Date: ClockDate,
  };
}

function browserHarness(elements) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const local = new Map();
  const document = {
    title: "grok/place · live mosaic",
    hidden: false,
    activeElement: null,
    body: element("body"),
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return element(); },
    addEventListener(type, handler) { const current = documentListeners.get(type) || []; current.push(handler); documentListeners.set(type, current); },
  };
  const window = {
    GROKPLACE_API: "http://127.0.0.1:8787",
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia() { return { matches: false, addEventListener() {} }; },
    addEventListener(type, handler) { const current = windowListeners.get(type) || []; current.push(handler); windowListeners.set(type, current); },
    dispatchEvent(event) { emit(windowListeners, event?.type, event); return true; },
    CustomEvent: CustomEventMock,
  };
  return {
    document,
    window,
    windowListeners,
    documentListeners,
    localStorage: { getItem(key) { return local.get(key) || null; }, setItem(key, value) { local.set(key, value); }, keys() { return [...local.keys()]; } },
  };
}

function response(status, retryAfter = "") {
  return { ok: false, status, headers: { get(name) { return name.toLowerCase() === "retry-after" ? retryAfter : null; } } };
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap], ["sound-btn", sound]]));
  const timers = fakeTimers();
  const calls = [];
  const math = Object.create(Math);
  math.random = () => 0;
  const context = vm.createContext({
    ...harness,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/v1/canvas") return response(429, "45");
      return response(503);
    },
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Set,
    Math: math,
    JSON,
    Date: timers.Date,
    performance,
    atob,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(mosaicSource, context, { filename: "public/mosaic.js" });
  vm.runInContext(radioSource, context, { filename: "public/radio.js" });
  await timers.tick(0);
  check(
    "429 honors Retry-After while overload retries use bounded exponential jitter",
    JSON.stringify(timers.delays()) === JSON.stringify([45_000, 48_000, 48_000]),
    JSON.stringify(timers.delays())
  );
  harness.document.hidden = true;
  emit(harness.documentListeners, "visibilitychange");
  await timers.tick(180_000);
  check(
    "hidden tabs perform no canvas, activity, provenance, goal, or music reads",
    JSON.stringify(calls.sort()) === JSON.stringify(["/v1/canvas", "/v1/feed", "/v1/music"]) && timers.count() === 0 && !calls.includes("/v1/tile") && !calls.includes("/v1/goals"),
    JSON.stringify({ calls, timers: timers.count() })
  );
  check(
    "ephemeral brush and ticker state is not persisted",
    harness.localStorage.keys().every((key) => ["grokplace-view-v1", "grokplace-activity-ticker-hidden-v1"].includes(key)),
    JSON.stringify(harness.localStorage.keys())
  );
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); this.listCalls = []; }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (key && typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async delete(key) {
    if (Array.isArray(key)) for (const name of key) this.values.delete(name);
    else this.values.delete(key);
  }
  async list({ prefix = "", limit = 1_000 } = {}) {
    this.listCalls.push({ prefix, limit });
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
}

{
  const staleReports = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
    `rpt:stale:${String(index).padStart(3, "0")}`,
    [{ a: "old-agent", t: index, reason: "unsafe" }],
  ]));
  const staleOwners = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`owner:${index}`, "old-agent"]));
  const storage = new MemoryStorage({
    ...staleReports,
    ...staleOwners,
    board: new Uint8Array(128 * 128).buffer,
    scores: new Int16Array(128 * 128).buffer,
    size: 128,
    schema: 4,
    "rpt:1,1": [{ a: "alice", t: 1, reason: "unsafe" }, { a: "bob", t: 2, reason: "unsafe" }],
    "vote:alice:1,1": 1,
    "agent:alice": { name: "alice", placements: 1 },
    "agent:old-agent": { name: "old-agent", placements: 1, reputation: 7, upvotesReceived: 2 },
  });
  const room = new GrokPlaceCanvas({ storage, getWebSockets() { return []; } }, { CANVAS_SIZE: "128", RESET_SECRET: "test-reset" });
  const response = await room.handleReset(new Request("https://test/internal/reset", {
    method: "POST",
    headers: { Authorization: "Bearer test-reset", "Content-Type": "application/json" },
    body: JSON.stringify({ clearMusic: false, clearLimits: false }),
  }), "*");
  const body = await response.json();
  const resetMeta = await storage.get("meta");
  const reportCleanupCalls = storage.listCalls.filter((call) => call.prefix === "rpt:");
  const staleReportsRemaining = [...storage.values.keys()].filter((key) => key.startsWith("rpt:stale:")).length;
  await storage.put("rpt:1,1", [{ a: "alice", t: 1, reason: "unsafe" }, { a: "bob", t: 2, reason: "unsafe" }]);
  room.rateLimit = async () => ({ ok: true });
  room.consumeProof = async () => ({ ok: true });
  room.requireAgentCapability = async () => ({ ok: true });
  const reportResponse = await room.handleReport(new Request("https://test/internal/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "alice", x: 1, y: 1, reason: "unsafe" }),
  }), 128, "*", "test-ip");
  const voteResponse = await room.handleVote(new Request("https://test/internal/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "alice", x: 122, y: 1, dir: 1 }),
  }), 128, "*", "test-ip");
  const oldAgentAfterVote = await storage.get("agent:old-agent");
  check(
    "reset removes tile state and rejects post-reset mutations against empty tiles",
    response.status === 200
      && body.ok === true
      && /^[a-f0-9]{16}$/.test(resetMeta.tileEpoch)
      && reportCleanupCalls.length === 1
      && reportCleanupCalls[0]?.limit === 128
      && staleReportsRemaining > 0
      && (await storage.get("vote:alice:1,1")) === undefined
      && (await storage.get("owner:250")) === "old-agent"
      && (await storage.get("agent:alice")) !== undefined
      && reportResponse.status === 409
      && (await reportResponse.clone().json()).error === "empty_tile"
      && (await storage.get("rpt:1,1"))?.length === 2
      && (await storage.get(`rpt:${resetMeta.tileEpoch}:1,1`)) === undefined
      && voteResponse.status === 409
      && (await voteResponse.clone().json()).error === "empty_tile"
      && oldAgentAfterVote.reputation === 7
      && oldAgentAfterVote.upvotesReceived === 2
      && (await storage.get(`vote:${resetMeta.tileEpoch}:alice:122,1`)) === undefined
      && new Uint8Array(await storage.get("board")).every((cell) => cell === 0),
    JSON.stringify({ body, resetMeta, reportCleanupCalls, staleReportsRemaining, report: await reportResponse.json(), vote: await voteResponse.json(), oldAgentAfterVote, keys: [...storage.values.keys()] })
  );
}

{
  const legacyBoard = new Uint8Array([1, 0, 0, 0]);
  const legacyStorage = new MemoryStorage({
    board: legacyBoard.buffer,
    scores: new Int16Array(4).buffer,
    size: 2,
    schema: 4,
    "owner:0": "legacy-agent",
    feed: Array.from({ length: 80 }, (_, index) => ({ type: "place", agent: "legacy-agent", x: 0, y: 0, c: 0, t: index })),
  });
  const before = Buffer.from(legacyBoard).toString("base64");
  const first = new GrokPlaceCanvas({ storage: legacyStorage }, { CANVAS_SIZE: "2" });
  const canvas = await first.handleCanvas(new URL("https://test/internal/canvas"), 2, "*");
  const second = new GrokPlaceCanvas({ storage: legacyStorage }, { CANVAS_SIZE: "2" });
  const tile = await second.handleTile(new URL("https://test/internal/tile?x=0&y=0"), 2, "*");
  const feed = await second.handleFeed("*");
  const canvasBody = await canvas.json();
  const tileBody = await tile.json();
  const feedBody = await feed.json();
  check(
    "Durable Object restart preserves legacy paint and leaves missing provenance unavailable",
    canvasBody.board === before && tileBody.tile?.placement?.provenance === "legacy_unavailable" && (await legacyStorage.get("provenance")) === undefined && (await legacyStorage.get("provenance:row:0")) === undefined,
    JSON.stringify({ canvas: canvasBody, tile: tileBody })
  );
  check(
    "legacy oversized activity storage is repaired to the durable feed cap",
    feedBody.feed?.length === 50 && (await legacyStorage.get("feed"))?.length === 50,
    JSON.stringify({ returned: feedBody.feed?.length, stored: (await legacyStorage.get("feed"))?.length })
  );
}

{
  const size = 128;
  const now = Date.now();
  const values = {
    board: new Uint8Array(size * size).fill(1).buffer,
    scores: new Int16Array(size * size).buffer,
    size,
    schema: 4,
  };
  for (let index = 0; index < 121; index++) {
    const x = index % size;
    const y = Math.floor(index / size);
    values[`protection:cell:${x}:${y}`] = {
      version: 1,
      x,
      y,
      colorIndex: 0,
      color: "#FFFFFF",
      protector: "protector",
      protectedAt: now - 1,
      expiresAt: now + 60_000,
    };
  }
  const storage = new MemoryStorage(values);
  const room = new GrokPlaceCanvas({ storage }, { CANVAS_SIZE: String(size) });
  const response = await room.handleCanvas(new URL("https://test/internal/canvas"), size, "*");
  const body = await response.json();
  check(
    "protection discovery bounds Durable Object list work and public payloads",
    body.protection?.active?.length === 120 && body.protection?.truncated === true && storage.listCalls.some((call) => call.prefix === "protection:cell:" && call.limit === 121),
    JSON.stringify({ protection: body.protection, listCalls: storage.listCalls })
  );
}

process.exitCode = failed ? 1 : 0;
