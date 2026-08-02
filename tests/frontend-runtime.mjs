#!/usr/bin/env node
/** Browser-runtime regression checks without a network or installed browser. */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const mosaicSource = readFileSync(new URL("../public/mosaic.js", import.meta.url), "utf8");
const mosaicHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const mosaicStyles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
check(
  "viewer includes a focusable read-only tile inspector without mutation controls",
  /id="board"[^>]*tabindex="0"/.test(mosaicHtml)
    && /id="tile-inspector"/.test(mosaicHtml)
    && /id="tile-inspector-close"/.test(mosaicHtml)
    && !/\/v1\/(place|vote|report)/.test(mosaicSource.slice(mosaicSource.indexOf("function fetchSelectedTile"), mosaicSource.indexOf("function clearSelectedTile"))),
  "tile inspector markup or read-only fetch contract missing"
);
check(
  "viewer renders a read-only active-plan overlay with every server-calculated state at desktop and phone widths",
  /id="plan-overlay-canvas"/.test(mosaicHtml)
    && /id="plan-overlay"/.test(mosaicHtml)
    && ["planned", "completed", "conflicting", "protected", "overwritten", "reclaimed", "remaining"].every((state) => mosaicHtml.includes(`plan-state-${state}`) && mosaicSource.includes(`"${state}"`))
    && mosaicSource.includes("renderPlanOverlay(data.planOverlay);")
    && mosaicStyles.includes("#plan-overlay-canvas")
    && mosaicStyles.includes(".plan-overlay")
    && /@media \(max-width:480px\)[\s\S]*\.plan-overlay/.test(mosaicStyles)
    && /@media \(prefers-reduced-motion:reduce\)/.test(mosaicStyles)
    && !mosaicSource.slice(mosaicSource.indexOf("function renderPlanOverlay"), mosaicSource.indexOf("function viewportSize")).includes("/v1/place"),
  "plan overlay or responsive/read-only contract missing"
);
check(
  "tile selection uses the existing canvas refresh path rather than a second polling loop",
  mosaicSource.includes("/v1/tile?")
    && mosaicSource.includes("if (selectedTile) void fetchSelectedTile(selectedTile);")
    && !mosaicSource.includes("tileTimer")
    && mosaicSource.includes('ev.type === "pointerup"')
    && mosaicSource.includes("document.activeElement === boardEl"),
  "selection or reconciliation contract missing"
);
check(
  "the mobile music control moves clear of an open tile inspector",
  mosaicSource.includes('classList.toggle("inspector-open", true)')
    && mosaicSource.includes('classList.toggle("inspector-open", false)')
    && mosaicStyles.includes(".inspector-open .sound-btn"),
  "open-inspector responsive state missing"
);
check(
  "painter attribution binds a CSS brush tip and escaped nametag to the exact feed color",
  /color: string/.test(mosaicSource)
    && /entry\.color, index \* 90/.test(mosaicSource)
    && /setProperty\("--brush-color", t\.color\)/.test(mosaicSource)
    && /class="brush-tip"/.test(mosaicSource)
    && /class="who">\$\{escapeHtml\(t\.agent\)\}/.test(mosaicSource)
    && /background:var\(--brush-color,#fff\)/.test(mosaicStyles),
  "paintbrush color or escaped nametag binding missing"
);
check(
  "painter attribution is ordered, bounded, motion-aware, and cleared when polling pauses",
  /fresh\.sort\(\(a, b\) => a\.t - b\.t \|\| a\.batchOrder - b\.batchOrder\)\.slice\(-8\)/.test(mosaicSource)
    && /nameTags\.length > 24/.test(mosaicSource)
    && /delayMs: Math\.max\(0, Math\.min\(630, delayMs\)\)/.test(mosaicSource)
    && /clearPainterTags\(\);/.test(mosaicSource)
    && /@keyframes brush-paint/.test(mosaicStyles)
    && /prefers-reduced-motion:reduce/.test(mosaicStyles),
  "painter lifecycle or reduced-motion contract missing"
);

function element(id = "") {
  const listeners = new Map();
  const attributes = new Map();
  const classes = new Set();
  const children = [];
  let innerHTML = "";
  const style = { setProperty(name, value) { this[name] = String(value); } };
  return {
    id,
    width: 128,
    height: 128,
    hidden: true,
    style,
    children,
    get innerHTML() { return innerHTML; },
    set innerHTML(value) { innerHTML = String(value); children.length = 0; },
    textContent: "",
    className: "",
    classList: {
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains(name) { return classes.has(name); },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    appendChild(child) { children.push(child); },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 800 }; },
    getContext() { return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }; },
    querySelector() { return null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) || null; },
    setPointerCapture() {},
    focus() { this.focused = true; },
    _listeners: listeners,
  };
}

class CustomEventMock {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

function browserHarness(elements, initialStorage = []) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const local = new Map(initialStorage);
  const document = {
    title: "grok/place · live mosaic",
    hidden: false,
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return element(); },
    addEventListener(type, handler) {
      const current = documentListeners.get(type) || [];
      current.push(handler);
      documentListeners.set(type, current);
    },
  };
  const window = {
    GROKPLACE_API: "http://127.0.0.1:8787",
    innerWidth: 1280,
    innerHeight: 800,
    visualViewport: null,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener(type, handler) {
      const current = windowListeners.get(type) || [];
      current.push(handler);
      windowListeners.set(type, current);
    },
    dispatchEvent(event) {
      emit(windowListeners, event?.type, event);
      return true;
    },
    CustomEvent: CustomEventMock,
  };
  return {
    document,
    window,
    windowListeners,
    documentListeners,
    localStorage: {
      getItem(key) { return local.get(key) || null; },
      setItem(key, value) { local.set(key, value); },
    },
  };
}

function fakeWebSockets() {
  const sockets = [];
  class WebSocketMock {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = [];
      sockets.push(this);
    }
    send(value) { this.sent.push(value); }
    open() {
      this.readyState = 1;
      this.onopen?.({ type: "open" });
    }
    message(data) { this.onmessage?.({ data }); }
    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closed.push({ code, reason });
      this.onclose?.({ code, reason });
    }
    fail() { this.onerror?.({ type: "error" }); }
  }
  return { WebSocketMock, sockets };
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
  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  async function tick(ms) {
    const target = now + ms;
    while (true) {
      let id = 0;
      let next = null;
      for (const [candidateId, job] of jobs) {
        if (job.at <= target && (!next || job.at < next.at || (job.at === next.at && candidateId < id))) {
          id = candidateId;
          next = job;
        }
      }
      if (!next) break;
      now = next.at;
      jobs.delete(id);
      next.callback();
      await flushMicrotasks();
    }
    now = target;
    await flushMicrotasks();
  }
  return {
    setTimeout,
    clearTimeout,
    tick,
    count() { return jobs.size; },
    delays() { return [...jobs.values()].map((job) => job.at - now).sort((a, b) => a - b); },
    now() { return now; },
    Date: ClockDate,
  };
}

function delayedFetch() {
  const pending = new Map();
  const maximum = new Map();
  let aborted = 0;
  const fetch = (url, options = {}) => {
    const path = new URL(url).pathname;
    pending.set(path, (pending.get(path) || 0) + 1);
    maximum.set(path, Math.max(maximum.get(path) || 0, pending.get(path)));
    return new Promise((resolve, reject) => {
      const finish = () => pending.set(path, Math.max(0, (pending.get(path) || 1) - 1));
      options.signal?.addEventListener("abort", () => {
        aborted++;
        finish();
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
      void resolve;
    });
  };
  return { fetch, pending, maximum, get aborted() { return aborted; } };
}

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap]]));
  const timers = fakeTimers();
  const live = fakeWebSockets();
  harness.window.WebSocket = live.WebSocketMock;
  const calls = [];
  const attempts = new Map();
  const math = Object.create(Math);
  math.random = () => 0;
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push({ path, at: timers.now() });
    const count = (attempts.get(path) || 0) + 1;
    attempts.set(path, count);
    if (count === 1 && (path === "/v1/canvas" || path === "/v1/feed")) {
      const retryAfter = path === "/v1/canvas" ? "120" : "125";
      return { ok: false, status: 429, headers: { get: () => retryAfter } };
    }
    if (path === "/v1/canvas") return { ok: true, json: async () => ({ ok: true, board: "AA==", size: 128, palette: ["#ffffff"], version: 1 }) };
    return { ok: true, json: async () => ({ ok: true, feed: [] }) };
  };
  const context = vm.createContext({
    ...harness,
    fetch,
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
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  await timers.tick(0);
  const socket = live.sockets[0];
  socket.open();
  for (let index = 0; index < 6; index++) {
    socket.message(`{"t":"canvas","v":${index + 1}}`);
    socket.message(`{"t":"activity","v":${index + 1}}`);
  }
  await timers.tick(0);
  check(
    "live invalidations cannot bypass canvas or feed Retry-After gates",
    attempts.get("/v1/canvas") === 1
      && attempts.get("/v1/feed") === 1
      && JSON.stringify(timers.delays()) === JSON.stringify([120_000, 125_000]),
    JSON.stringify({ attempts: Object.fromEntries(attempts), delays: timers.delays(), calls })
  );
  await timers.tick(119_999);
  socket.message('{"t":"canvas","v":99}');
  socket.message('{"t":"activity","v":99}');
  await timers.tick(1);
  check(
    "canvas resumes only when its retry gate expires",
    attempts.get("/v1/canvas") === 2 && attempts.get("/v1/feed") === 1,
    JSON.stringify(calls)
  );
  await timers.tick(5_000);
  check(
    "feed resumes only when its retry gate expires",
    attempts.get("/v1/feed") === 2,
    JSON.stringify(calls)
  );
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const share = element("share-btn");
  const toast = element("toast");
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap], ["share-btn", share], ["toast", toast]]));
  harness.window.GROKPLACE_API = "https://preview.grokplace.test/agent-api/";
  let shareAttempts = 0;
  const copied = [];
  const navigator = {
    share: async () => {
      shareAttempts++;
      throw new Error("share unavailable");
    },
    clipboard: { async writeText(text) { copied.push(text); } },
  };
  const context = vm.createContext({
    ...harness,
    navigator,
    fetch: async () => ({ ok: false, status: 503 }),
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Math,
    JSON,
    Date,
    performance,
    atob,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  share._listeners.get("click")();
  await flush();
  const invite = copied[0] || "";
  const playbookUrl = "https://preview.grokplace.test/agent-api/llms.txt";
  const actions = [
    `1. Read ${playbookUrl}.`,
    "2. Claim your agent name.",
    "3. Inspect the live board.",
    "4. Preserve coherent art; place up to 5 empty tiles.",
    "5. If the goal is blank, ask the human what to draw.",
  ];
  const actionPositions = actions.map((action) => invite.indexOf(action));
  check("invite falls back from Web Share to clipboard", shareAttempts === 1 && copied.length === 1 && toast.textContent === "Invite copied — paste it to your agent");
  check("invite uses the exact dynamic playbook URL", invite.includes(playbookUrl) && !invite.includes("https://grokplace.barnlabs.net/llms.txt"), invite);
  check("invite directly briefs the receiving agent", invite.startsWith("You are the receiving agent for grok/place.\nGoal: [what to draw]\n"), invite);
  check("invite actions are complete and ordered", actionPositions.every((position, index) => position >= 0 && (index === 0 || position > actionPositions[index - 1])), invite);
  for (const handler of harness.windowListeners.get("pagehide") || []) handler({ persisted: false });
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap]]));
  const tracker = delayedFetch();
  const context = vm.createContext({
    ...harness,
    fetch: tracker.fetch,
    AbortController,
    DOMException,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Math,
    JSON,
    Date,
    performance,
    atob,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  await flush(20);
  check("canvas polling has one request in flight", tracker.pending.get("/v1/canvas") === 1 && tracker.maximum.get("/v1/canvas") === 1);
  check("feed polling has one request in flight", tracker.pending.get("/v1/feed") === 1 && tracker.maximum.get("/v1/feed") === 1);
  await flush(20);
  check("stalled canvas/feed requests do not multiply", tracker.maximum.get("/v1/canvas") === 1 && tracker.maximum.get("/v1/feed") === 1);
  for (const handler of harness.windowListeners.get("pagehide") || []) handler({ persisted: false });
  await flush();
  check("pagehide aborts canvas and feed", tracker.pending.get("/v1/canvas") === 0 && tracker.pending.get("/v1/feed") === 0 && tracker.aborted === 2);
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap]]));
  const timers = fakeTimers();
  const calls = new Map();
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    const attempt = (calls.get(path) || 0) + 1;
    calls.set(path, attempt);
    if (attempt === 1) return { ok: false, status: 1101 };
    if (path === "/v1/canvas") {
      return { ok: true, json: async () => ({ ok: true, board: "AA==", size: 128, palette: ["#ffffff"], version: attempt }) };
    }
    return { ok: true, json: async () => ({ ok: true, feed: [] }) };
  };
  const context = vm.createContext({
    ...harness,
    fetch,
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Math,
    JSON,
    Date: timers.Date,
    performance,
    atob,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  await timers.tick(0);
  check("canvas and feed use exponential retry after a 1101", JSON.stringify(timers.delays()) === JSON.stringify([24_000, 60_000]), JSON.stringify(timers.delays()));
  harness.document.hidden = true;
  emit(harness.documentListeners, "visibilitychange");
  check("hidden mosaic cancels every scheduled DO read", timers.count() === 0, `timers=${timers.count()}`);
  await timers.tick(120_000);
  check("hidden mosaic does not keep polling", calls.get("/v1/canvas") === 1 && calls.get("/v1/feed") === 1, JSON.stringify(Object.fromEntries(calls)));
  harness.document.hidden = false;
  emit(harness.documentListeners, "visibilitychange");
  emit(harness.documentListeners, "visibilitychange");
  emit(harness.windowListeners, "focus");
  check("repeat resume events retain one mosaic timer per resource", timers.count() === 2, `timers=${timers.count()}`);
  await timers.tick(0);
  check("mosaic recovers immediately on return to the foreground", calls.get("/v1/canvas") === 2 && calls.get("/v1/feed") === 2, JSON.stringify(Object.fromEntries(calls)));
  check("successful mosaic recovery returns to the bounded foreground cadence", JSON.stringify(timers.delays()) === JSON.stringify([12_000, 30_000]), JSON.stringify(timers.delays()));
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap], ["sound-btn", sound]]));
  const timers = fakeTimers();
  const live = fakeWebSockets();
  harness.window.WebSocket = live.WebSocketMock;
  const calls = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/v1/canvas") return { ok: true, json: async () => ({ ok: true, board: "AA==", size: 128, palette: ["#ffffff"], version: 1 }) };
    if (path === "/v1/feed") return { ok: true, json: async () => ({ ok: true, feed: [] }) };
    return { ok: true, json: async () => ({ ok: true, now: null }) };
  };
  const context = vm.createContext({
    ...harness,
    fetch,
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Set,
    Math,
    JSON,
    Date,
    performance,
    atob,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  check("one visible tab opens exactly one anonymous live socket", live.sockets.length === 1 && live.sockets[0].url === "ws://127.0.0.1:8787/v1/live", JSON.stringify(live.sockets.map((socket) => socket.url)));
  const socket = live.sockets[0];
  socket.open();
  socket.message('{"t":"ready","v":0}');
  for (let index = 0; index < 5; index++) emit(harness.windowListeners, "focus");
  check("repeated visible focus does not create a reconnect storm", live.sockets.length === 1, `sockets=${live.sockets.length}`);
  await timers.tick(0);
  const count = (path) => calls.filter((value) => value === path).length;
  check("ready coalesces one canvas, activity, and music refresh", count("/v1/canvas") === 1 && count("/v1/feed") === 1 && count("/v1/music") === 1, JSON.stringify(calls));
  socket.message('{"t":"ready","v":0}');
  await timers.tick(0);
  check("a duplicate ready event does not create double immediate reads", count("/v1/canvas") === 1 && count("/v1/feed") === 1 && count("/v1/music") === 1, JSON.stringify(calls));
  socket.message("{");
  socket.message("x".repeat(97));
  socket.message('{"t":"canvas","v":1,"extra":true}');
  await timers.tick(0);
  check("malformed, oversize, and untrusted live messages are ignored", count("/v1/canvas") === 1 && count("/v1/feed") === 1 && count("/v1/music") === 1, JSON.stringify(calls));
  socket.message('{"t":"canvas","v":1}');
  socket.message('{"t":"canvas","v":1}');
  await timers.tick(0);
  check("canvas invalidations coalesce and fetch only the canvas", count("/v1/canvas") === 2 && count("/v1/feed") === 1 && count("/v1/music") === 1, JSON.stringify(calls));
  socket.message('{"t":"activity","v":1}');
  socket.message('{"t":"activity","v":1}');
  await timers.tick(0);
  check("activity invalidations coalesce and fetch only the feed", count("/v1/canvas") === 2 && count("/v1/feed") === 2 && count("/v1/music") === 1, JSON.stringify(calls));
  socket.message('{"t":"music","v":1}');
  socket.message('{"t":"music","v":1}');
  await timers.tick(0);
  check("music invalidations coalesce and fetch only music", count("/v1/canvas") === 2 && count("/v1/feed") === 2 && count("/v1/music") === 2, JSON.stringify(calls));
  check("the viewer never sends a websocket command", socket.sent.length === 0, JSON.stringify(socket.sent));
  socket.close();
  const retryDelays = timers.delays();
  check("closed live sockets restore fallback reads and retry with bounded jitter", retryDelays.filter((delay) => delay === 0).length === 3 && retryDelays.some((delay) => delay >= 800 && delay <= 1_200), JSON.stringify(retryDelays));
  await timers.tick(1_200);
  check("a closed live socket retries once after its bounded backoff", live.sockets.length === 2, `sockets=${live.sockets.length}`);
  harness.document.hidden = true;
  emit(harness.documentListeners, "visibilitychange");
  emit(harness.windowListeners, "focus");
  check("hidden tabs close live sockets and schedule neither reads nor reconnects", live.sockets[1].closed.length === 1 && timers.count() === 0, JSON.stringify({ closed: live.sockets[1].closed, timers: timers.count() }));
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap], ["sound-btn", sound]]));
  const timers = fakeTimers();
  const live = fakeWebSockets();
  harness.window.WebSocket = live.WebSocketMock;
  const calls = [];
  let musicGets = 0;
  const shortestTrack = {
    id: "cmp_shortest_live",
    startedAt: 0,
    endsAt: 84,
    composition: { bpm: 180, waveform: "sine", notes: [{ note: "A4", at: 0, duration: 1, velocity: 0.7 }] },
  };
  const context = vm.createContext({
    ...harness,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      calls.push({ path, at: timers.now() });
      if (path === "/v1/canvas") return { ok: true, json: async () => ({ ok: true, board: "AA==", size: 128, palette: ["#ffffff"], version: 1 }) };
      if (path === "/v1/feed") return { ok: true, json: async () => ({ ok: true, feed: [] }) };
      musicGets++;
      return { ok: true, json: async () => ({ ok: true, now: musicGets === 1 ? shortestTrack : null }) };
    },
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Set,
    Math,
    JSON,
    Date,
    performance,
    atob,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  live.sockets[0].open();
  live.sockets[0].message('{"t":"ready","v":0}');
  await timers.tick(29_999);
  check("a connected shortest-valid track does not wait nearly two minutes for promotion", musicGets === 1, JSON.stringify(calls));
  await timers.tick(1);
  const musicCallsAtThirtySeconds = calls.filter((call) => call.path === "/v1/music");
  check("connected music reconciliation fetches again at thirty seconds", musicGets === 2 && musicCallsAtThirtySeconds[1]?.at === 30_000, JSON.stringify(musicCallsAtThirtySeconds));
  await timers.tick(270_000);
  const byPath = calls.reduce((counts, call) => ({ ...counts, [call.path]: (counts[call.path] || 0) + 1 }), {});
  check("a healthy live socket holds the five-minute budget to twenty reads", calls.length === 20 && byPath["/v1/canvas"] === 6 && byPath["/v1/feed"] === 3 && byPath["/v1/music"] === 11, JSON.stringify({ calls: calls.length, byPath }));
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const activityTicker = element("activity-ticker");
  const tickerTrack = element("ticker-track");
  const tickerToggle = element("ticker-toggle");
  const tickerElements = new Map([
    ["board", board], ["canvas-wrap", wrap], ["activity-ticker", activityTicker], ["ticker-track", tickerTrack], ["ticker-toggle", tickerToggle],
  ]);
  wrap.appendChild = (child) => { wrap.children.push(child); if (child.id) tickerElements.set(child.id, child); };
  const harness = browserHarness(tickerElements);
  const timers = fakeTimers();
  const motionListeners = [];
  const reduceMotion = {
    matches: false,
    addEventListener(type, listener) { if (type === "change") motionListeners.push(listener); },
  };
  harness.window.matchMedia = () => reduceMotion;
  const feed = Array.from({ length: 30 }, (_, index) => ({
    type: index === 0 ? "protect" : "place",
    agent: index === 0 ? "<agent&name>" : `agent-${index}`,
    x: index % 8,
    y: Math.floor(index / 8),
    c: 0,
    color: "#A1B2C3",
    goal: index === 0 ? "<make this safe>" : `goal-${index}`,
    t: 500 - index,
  }));
  const calls = [];
  const context = vm.createContext({
    ...harness,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/v1/canvas") return { ok: true, json: async () => ({ ok: true, board: "AA==", size: 128, palette: ["#A1B2C3"], version: 1 }) };
      if (path === "/v1/feed") return { ok: true, json: async () => ({ ok: true, feed }) };
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    },
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Math,
    JSON,
    Date,
    performance,
    atob,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  await timers.tick(0);
  check("activity ticker renders escaped agent, exact color, coordinate, region, and goal fields", tickerTrack.innerHTML.includes("&lt;agent&amp;name&gt;") && tickerTrack.innerHTML.includes("#A1B2C3") && tickerTrack.innerHTML.includes("(0, 0)") && tickerTrack.innerHTML.includes("R1C1") && tickerTrack.innerHTML.includes("&lt;make this safe&gt;"), tickerTrack.innerHTML);
  check("activity ticker never injects raw feed HTML", !tickerTrack.innerHTML.includes("<agent&name>") && !tickerTrack.innerHTML.includes("<make this safe>"), tickerTrack.innerHTML);
  check("activity ticker duplicates only a bounded first pass for horizontal motion", (tickerTrack.innerHTML.match(/data-x=/g) || []).length === 12 && readFileSync(new URL("public/styles.css", root), "utf8").includes("ticker-slide") && readFileSync(new URL("public/styles.css", root), "utf8").includes("translateX(-50%)"), tickerTrack.innerHTML);
  feed.unshift(
    { type: "place", agent: "batch-second", x: 2, y: 0, c: 0, color: "#A1B2C3", goal: "batch", t: 501, batchOrder: 1 },
    { type: "place", agent: "batch-first", x: 1, y: 0, c: 0, color: "#A1B2C3", goal: "batch", t: 501, batchOrder: 0 },
  );
  harness.document.hidden = true;
  emit(harness.documentListeners, "visibilitychange");
  harness.document.hidden = false;
  emit(harness.documentListeners, "visibilitychange");
  await timers.tick(0);
  const painterChildren = tickerElements.get("painter-tags")?.children || [];
  check(
    "equal-time batch brushes animate in original placement order",
    painterChildren.length === 2
      && painterChildren[0].innerHTML.includes("batch-first")
      && painterChildren[0].style["--brush-delay"] === "0ms"
      && painterChildren[1].innerHTML.includes("batch-second")
      && painterChildren[1].style["--brush-delay"] === "90ms",
    JSON.stringify(painterChildren.map((child) => ({ html: child.innerHTML, delay: child.style["--brush-delay"] })))
  );
  const pollCallsBeforeInteractions = calls.length;
  tickerTrack._listeners.get("click")({
    target: {
      closest() {
        return { getAttribute(name) { return name === "data-x" ? "3" : name === "data-y" ? "4" : null; } };
      },
    },
  });
  check("selecting an activity item focuses its board tile without a new polling route", board.focused === true && board.style.transform.includes("px") && calls.filter((path) => path === "/v1/tile").length === 0, JSON.stringify({ style: board.style, calls }));
  activityTicker._listeners.get("focusin")();
  check("ticker pauses while its hide control has keyboard focus", activityTicker.classList.contains("is-paused"), "ticker did not pause on focus");
  activityTicker._listeners.get("focusout")();
  check("ticker resumes after keyboard focus leaves its controls", !activityTicker.classList.contains("is-paused"), "ticker remained paused after focusout");
  tickerToggle._listeners.get("click")();
  check("ticker hides in place and persists its state", activityTicker.classList.contains("is-hidden") && harness.localStorage.getItem("grokplace-activity-ticker-hidden-v1") === "1", JSON.stringify({ hidden: activityTicker.classList.contains("is-hidden"), stored: harness.localStorage.getItem("grokplace-activity-ticker-hidden-v1") }));
  const reloadBoard = element("board");
  const reloadWrap = element("canvas-wrap");
  const reloadTicker = element("activity-ticker");
  const reloadTrack = element("ticker-track");
  const reloadToggle = element("ticker-toggle");
  const reloadHarness = browserHarness(
    new Map([["board", reloadBoard], ["canvas-wrap", reloadWrap], ["activity-ticker", reloadTicker], ["ticker-track", reloadTrack], ["ticker-toggle", reloadToggle]]),
    [["grokplace-activity-ticker-hidden-v1", "1"]]
  );
  const reloadTimers = fakeTimers();
  reloadHarness.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  const reloadContext = vm.createContext({
    ...reloadHarness,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/canvas") return { ok: true, json: async () => ({ ok: true, board: "AA==", size: 128, palette: ["#A1B2C3"], version: 1 }) };
      if (path === "/v1/feed") return { ok: true, json: async () => ({ ok: true, feed: [] }) };
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    },
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Math,
    JSON,
    Date,
    performance,
    atob,
    setTimeout: reloadTimers.setTimeout,
    clearTimeout: reloadTimers.clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), reloadContext, { filename: "public/mosaic.js" });
  await reloadTimers.tick(0);
  check("ticker restores its persisted hidden state after reload", reloadTicker.classList.contains("is-hidden") && reloadToggle.getAttribute("aria-pressed") === "true", JSON.stringify({ hidden: reloadTicker.classList.contains("is-hidden"), pressed: reloadToggle.getAttribute("aria-pressed") }));
  emit(reloadHarness.windowListeners, "pagehide", { persisted: false });
  tickerToggle._listeners.get("click")();
  harness.document.hidden = true;
  emit(harness.documentListeners, "visibilitychange");
  check("ticker pauses while backgrounded", activityTicker.classList.contains("is-paused"), "ticker did not pause");
  harness.document.hidden = false;
  emit(harness.documentListeners, "visibilitychange");
  reduceMotion.matches = true;
  for (const listener of motionListeners) listener({ matches: true });
  check("ticker pauses when reduced motion is requested", activityTicker.classList.contains("is-paused"), "ticker did not respect reduced motion");
  check("ticker interactions do not create a polling loop", calls.length === pollCallsBeforeInteractions, JSON.stringify(calls));
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["sound-btn", sound]]));
  const timers = fakeTimers();
  const math = Object.create(Math);
  math.random = () => 0;
  let calls = 0;
  const context = vm.createContext({
    ...harness,
    fetch: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => "120" } };
      return { ok: true, json: async () => ({ ok: true, now: null }) };
    },
    AbortController,
    URL,
    Set,
    Math: math,
    JSON,
    Date: timers.Date,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  await timers.tick(0);
  for (let index = 0; index < 6; index++) emit(harness.windowListeners, "grokplace:live", { detail: { t: "music", v: index + 1 } });
  await timers.tick(10_000);
  harness.document.hidden = true;
  emit(harness.documentListeners, "visibilitychange");
  await timers.tick(30_000);
  harness.document.hidden = false;
  emit(harness.documentListeners, "visibilitychange");
  emit(harness.windowListeners, "focus");
  emit(harness.windowListeners, "grokplace:live", { detail: { t: "music", v: 99 } });
  await timers.tick(79_999);
  check(
    "music live, focus, and visibility triggers cannot bypass Retry-After",
    calls === 1 && JSON.stringify(timers.delays()) === JSON.stringify([1]),
    JSON.stringify({ calls, delays: timers.delays() })
  );
  await timers.tick(1);
  check("music resumes when its absolute retry gate expires", calls === 2, `calls=${calls}`);
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["sound-btn", sound]]));
  const timers = fakeTimers();
  const math = Object.create(Math);
  math.random = () => 1;
  let calls = 0;
  const context = vm.createContext({
    ...harness,
    fetch: async () => {
      calls++;
      return { ok: false, status: 503, headers: { get: () => null } };
    },
    AbortController,
    URL,
    Set,
    Math: math,
    JSON,
    Date: timers.Date,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  await timers.tick(0);
  await timers.tick(60_000);
  check(
    "music jitter stays capped at sixty seconds across consecutive overloads",
    calls === 2 && JSON.stringify(timers.delays()) === JSON.stringify([60_000]),
    JSON.stringify({ calls, delays: timers.delays() })
  );
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["sound-btn", sound]]));
  const tracker = delayedFetch();
  const context = vm.createContext({
    ...harness,
    fetch: tracker.fetch,
    AbortController,
    DOMException,
    URL,
    Set,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  await flush(20);
  check("music polling has one request in flight", tracker.pending.get("/v1/music") === 1 && tracker.maximum.get("/v1/music") === 1);
  await flush(20);
  check("stalled music requests do not multiply", tracker.maximum.get("/v1/music") === 1);
  for (const handler of harness.windowListeners.get("pagehide") || []) handler({ persisted: false });
  await flush();
  check("pagehide aborts music polling", tracker.pending.get("/v1/music") === 0 && tracker.aborted === 1);
}

{
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["sound-btn", sound]]));
  const timers = fakeTimers();
  let calls = 0;
  const context = vm.createContext({
    ...harness,
    fetch: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 1101 };
      return { ok: true, json: async () => ({ ok: true, now: null }) };
    },
    AbortController,
    URL,
    Set,
    Math,
    JSON,
    Date: timers.Date,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  await timers.tick(0);
  check("music uses exponential retry after a 1101", JSON.stringify(timers.delays()) === JSON.stringify([60_000]), JSON.stringify(timers.delays()));
  harness.document.hidden = true;
  emit(harness.documentListeners, "visibilitychange");
  check("hidden radio cancels scheduled DO reads", timers.count() === 0, `timers=${timers.count()}`);
  await timers.tick(120_000);
  check("hidden radio does not keep polling", calls === 1, `calls=${calls}`);
  harness.document.hidden = false;
  emit(harness.documentListeners, "visibilitychange");
  emit(harness.windowListeners, "focus");
  check("repeat radio resume events retain one timer", timers.count() === 1, `timers=${timers.count()}`);
  await timers.tick(0);
  check("radio recovers immediately and returns to its normal cadence", calls === 2 && JSON.stringify(timers.delays()) === JSON.stringify([30_000]), JSON.stringify({ calls, delays: timers.delays() }));
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap], ["sound-btn", sound]]));
  harness.document.hidden = true;
  const timers = fakeTimers();
  const calls = [];
  const context = vm.createContext({
    ...harness,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/v1/canvas") return { ok: true, json: async () => ({ ok: true, board: "AA==", size: 128, palette: ["#ffffff"], version: 1 }) };
      if (path === "/v1/feed") return { ok: true, json: async () => ({ ok: true, feed: [] }) };
      return { ok: true, json: async () => ({ ok: true, now: null }) };
    },
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Set,
    Math,
    JSON,
    Date,
    performance,
    atob,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  await timers.tick(120_000);
  check("an initially hidden viewer schedules no DO reads", calls.length === 0 && timers.count() === 0, JSON.stringify({ calls, timers: timers.count() }));
  harness.document.hidden = false;
  emit(harness.documentListeners, "visibilitychange");
  check("first visibility schedules one immediate poll per resource", timers.count() === 3, `timers=${timers.count()}`);
  await timers.tick(0);
  const callsByPath = calls.reduce((counts, path) => ({ ...counts, [path]: (counts[path] || 0) + 1 }), {});
  check("first visible refresh makes exactly one canvas, feed, and music read", calls.length === 3 && callsByPath["/v1/canvas"] === 1 && callsByPath["/v1/feed"] === 1 && callsByPath["/v1/music"] === 1, JSON.stringify(callsByPath));
  check("initially hidden recovery returns to bounded timers", JSON.stringify(timers.delays()) === JSON.stringify([12_000, 30_000, 30_000]), JSON.stringify(timers.delays()));
  emit(harness.windowListeners, "focus");
  emit(harness.windowListeners, "focus");
  check("visible focus after hidden recovery leaves bounded timers intact", JSON.stringify(timers.delays()) === JSON.stringify([12_000, 30_000, 30_000]), JSON.stringify(timers.delays()));
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

{
  const sound = element("sound-btn");
  const attributes = new Map();
  sound.querySelector = () => element();
  sound.setAttribute = (name, value) => attributes.set(name, String(value));
  const harness = browserHarness(new Map([["sound-btn", sound]]));
  let contexts = 0;
  let starts = 0;
  class AudioContextMock {
    constructor() { contexts++; this.currentTime = 0; this.state = "running"; this.destination = {}; }
    createGain() {
      return {
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect(node) { return node; },
        disconnect() {},
      };
    }
    createOscillator() {
      return {
        frequency: { setValueAtTime() {} },
        connect(node) { return node; },
        disconnect() {},
        start() { starts++; },
        stop() {},
        onended: null,
        type: "sine",
      };
    }
    close() { return Promise.resolve(); }
    resume() { return Promise.resolve(); }
  }
  harness.window.AudioContext = AudioContextMock;
  const startedAt = Date.now() - 100;
  const track = {
    id: "cmp_bfcache",
    startedAt,
    endsAt: startedAt + 10_000,
    composition: { bpm: 120, waveform: "sine", notes: [{ note: "A4", at: 0, duration: 4, velocity: 0.7 }] },
  };
  const context = vm.createContext({
    ...harness,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, now: track }) }),
    AbortController,
    URL,
    Set,
    Math,
    JSON,
    Date,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  await flush(20);
  sound._listeners.get("click")({ preventDefault() {}, stopPropagation() {} });
  check("enabled composition starts an audio context", contexts === 1 && starts === 1 && attributes.get("aria-pressed") === "true");
  for (const handler of harness.windowListeners.get("pagehide") || []) handler({ persisted: true });
  for (const handler of harness.windowListeners.get("pageshow") || []) handler({ persisted: true });
  await flush();
  check("bfcache restore reschedules enabled composition", contexts === 2 && starts === 2 && attributes.get("aria-pressed") === "true");
  for (const handler of harness.windowListeners.get("pagehide") || []) handler({ persisted: false });
}

{
  const board = element("board");
  const wrap = element("canvas-wrap");
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["board", board], ["canvas-wrap", wrap], ["sound-btn", sound]]));
  const timers = fakeTimers();
  const frequencies = [];
  class AudioContextMock {
    constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
    createGain() {
      return {
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect(node) { return node; },
        disconnect() {},
      };
    }
    createOscillator() {
      return {
        frequency: { setValueAtTime(value) { frequencies.push(value); } },
        connect(node) { return node; },
        disconnect() {},
        start() {},
        stop() {},
        onended: null,
        type: "sine",
      };
    }
    close() { return Promise.resolve(); }
    resume() { return Promise.resolve(); }
  }
  harness.window.AudioContext = AudioContextMock;
  const initialTime = 2_000_000_000_000;
  const first = {
    id: "cmp_first",
    startedAt: initialTime,
    endsAt: initialTime + 84,
    composition: { bpm: 180, waveform: "sine", notes: [{ note: "A4", at: 0, duration: 1, velocity: 0.7 }] },
  };
  const second = {
    id: "cmp_second",
    startedAt: initialTime + 30_000,
    endsAt: initialTime + 120_000,
    composition: { bpm: 120, waveform: "triangle", notes: [{ note: "C5", at: 0, duration: 4, velocity: 0.7 }] },
  };
  const calls = [];
  let musicGets = 0;
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push({ path, at: timers.now() });
    if (path === "/v1/canvas") return { ok: true, json: async () => ({ ok: true, board: "AA==", size: 128, palette: ["#ffffff"], version: 1 }) };
    if (path === "/v1/feed") return { ok: true, json: async () => ({ ok: true, feed: [] }) };
    if (path === "/v1/music") {
      musicGets++;
      return { ok: true, json: async () => ({ ok: true, now: musicGets === 1 ? first : second }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };
  const context = vm.createContext({
    ...harness,
    fetch,
    AbortController,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Map,
    Set,
    Math,
    JSON,
    Date: { now: () => initialTime + timers.now() },
    performance,
    atob,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(new URL("public/mosaic.js", root), "utf8"), context, { filename: "public/mosaic.js" });
  vm.runInContext(readFileSync(new URL("public/radio.js", root), "utf8"), context, { filename: "public/radio.js" });
  await timers.tick(0);
  sound._listeners.get("click")({ preventDefault() {}, stopPropagation() {} });
  await timers.tick(100);
  check("shortest valid track completion schedules no viewer advance or immediate read", calls.length === 3 && musicGets === 1 && !calls.some((call) => call.path === "/v1/music/advance"), JSON.stringify(calls));
  for (let i = 0; i < 29; i++) {
    emit(harness.windowListeners, "focus");
    await timers.tick(1_000);
  }
  emit(harness.windowListeners, "focus");
  await timers.tick(900);
  check("the next track arrives through the single normal music poll", musicGets === 2 && frequencies.some((value) => Math.abs(value - 523.251) < 0.01), JSON.stringify({ musicGets, frequencies }));
  for (let i = 0; i < 30; i++) {
    emit(harness.windowListeners, "focus");
    await timers.tick(1_000);
  }
  const callsByPath = calls.reduce((counts, call) => ({ ...counts, [call.path]: (counts[call.path] || 0) + 1 }), {});
  check("repeat visible focus events cannot exceed twelve DO calls through sixty seconds", calls.length === 12 && callsByPath["/v1/canvas"] === 6 && callsByPath["/v1/feed"] === 3 && callsByPath["/v1/music"] === 3, JSON.stringify({ callsByPath, calls }));
  check("the viewer never calls the public music advance route", !calls.some((call) => call.path === "/v1/music/advance"), JSON.stringify(calls));
  emit(harness.windowListeners, "pagehide", { persisted: false });
}

process.exitCode = failed ? 1 : 0;
