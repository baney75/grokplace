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

function element(id = "") {
  const listeners = new Map();
  return {
    id,
    width: 128,
    height: 128,
    hidden: true,
    style: {},
    textContent: "",
    className: "",
    classList: { toggle() {} },
    addEventListener(type, handler) { listeners.set(type, handler); },
    appendChild() {},
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 800 }; },
    getContext() { return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }; },
    querySelector() { return null; },
    setAttribute() {},
    setPointerCapture() {},
    _listeners: listeners,
  };
}

function browserHarness(elements) {
  const windowListeners = new Map();
  const local = new Map();
  const document = {
    title: "grok/place · live mosaic",
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return element(); },
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
  };
  return {
    document,
    window,
    windowListeners,
    localStorage: {
      getItem(key) { return local.get(key) || null; },
      setItem(key, value) { local.set(key, value); },
    },
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
  const sound = element("sound-btn");
  sound.querySelector = () => element();
  const harness = browserHarness(new Map([["sound-btn", sound]]));
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
  const initialTime = Date.now();
  const first = {
    id: "cmp_first",
    advanceToken: "a".repeat(32),
    startedAt: initialTime,
    endsAt: initialTime + 180,
    composition: { bpm: 120, waveform: "sine", notes: [{ note: "A4", at: 0, duration: 4, velocity: 0.7 }] },
  };
  const second = {
    id: "cmp_second",
    advanceToken: "b".repeat(32),
    startedAt: initialTime + 180,
    endsAt: initialTime + 10_000,
    composition: { bpm: 120, waveform: "triangle", notes: [{ note: "C5", at: 0, duration: 4, velocity: 0.7 }] },
  };
  let gets = 0;
  let advanceBody = null;
  let advanceAt = 0;
  let secondFetchedAt = 0;
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/music/advance") {
      advanceAt = Date.now();
      advanceBody = JSON.parse(options.body);
      return { ok: false, status: 409, json: async () => ({ ok: false, error: "stale_composition" }) };
    }
    gets++;
    if (gets > 1) secondFetchedAt = Date.now();
    return { ok: true, json: async () => ({ ok: true, now: gets === 1 ? first : second }) };
  };
  const context = vm.createContext({
    ...harness,
    fetch,
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
  await flush(260);
  check("radio advance sends the exact current id and token inside the end window", advanceAt > 0 && advanceAt <= first.endsAt && first.endsAt - advanceAt <= 1500 && advanceBody?.compositionId === first.id && advanceBody?.advanceToken === first.advanceToken, JSON.stringify({ advanceAt, endsAt: first.endsAt, advanceBody }));
  check("stale advance response immediately refetches the promoted composition", gets >= 2 && secondFetchedAt > 0 && secondFetchedAt - advanceAt < 250, `gets=${gets} handoffMs=${secondFetchedAt - advanceAt}`);
  check("promoted composition is scheduled without the four-second polling gap", frequencies.some((value) => Math.abs(value - 523.251) < 0.01), JSON.stringify(frequencies));
  for (const handler of harness.windowListeners.get("pagehide") || []) handler({ persisted: false });
}

process.exitCode = failed ? 1 : 0;
