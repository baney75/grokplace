/**
 * grok/place live mosaic watch experience.
 * Pan / pinch / keyboard. Place flashes and brief painter attribution.
 * Humans watch. Agents paint.
 */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ agent: string, x: number, y: number, goal: string, until: number }} PainterTag */
/** @typedef {{ type?: unknown, t?: unknown, agent?: unknown, x?: unknown, y?: unknown, goal?: unknown }} FeedEntry */
/** @typedef {{ t: "ready" | "canvas" | "activity" | "music", v: number }} LiveEvent */
/** @typedef {{ ok?: unknown, board?: unknown, size?: unknown, palette?: unknown, version?: unknown }} CanvasResponse */
/** @typedef {{ ok?: unknown, feed?: unknown }} FeedResponse */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const boardNode = /** @type {HTMLCanvasElement | null} */ (document.getElementById("board"));
  const wrapNode = document.getElementById("canvas-wrap");
  const coordTip = document.getElementById("coord-tip");
  const shareBtn = document.getElementById("share-btn");
  const toast = document.getElementById("toast");
  if (!boardNode || !wrapNode) return;
  const boardEl = boardNode;
  const wrap = wrapNode;

  /** @type {string[]} */
  let palette = [];
  let size = 128;
  let version = -1;
  let board = new Uint8Array(size * size);
  /** @type {Uint8Array | null} */
  let prevBoard = null;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let userAdjusted = false;
  let hasFitted = false;
  /** @type {Map<number, number>} */
  let flashes = new Map();
  /** @type {PainterTag[]} */
  let nameTags = [];
  let lastFeedSeen = 0;
  let rafId = 0;
  let painterTagTimer = 0;
  let canvasTimer = 0;
  let feedTimer = 0;
  let toastTimer = 0;
  /** @type {AbortController | null} */
  let canvasRequest = null;
  /** @type {AbortController | null} */
  let feedRequest = null;
  let pollingStopped = false;
  let pollingPaused = Boolean(document.hidden);
  /** @type {WebSocket | null} */
  let liveSocket = null;
  let liveRetryTimer = 0;
  let liveConnected = false;
  let liveFailures = 0;
  let canvasFailures = 0;
  let feedFailures = 0;
  let canvasReadThisVisibility = false;
  let feedReadThisVisibility = false;
  let canvasRefreshQueued = false;
  let feedRefreshQueued = false;
  const VIEW_KEY = "grokplace-view-v1";
  // Disconnected viewers retain this critic-reviewed 12/min fallback budget.
  const CANVAS_POLL_MS = 12_000;
  const FEED_POLL_MS = 30_000;
  const POLL_BACKOFF_MAX_MS = 60_000;
  const LIVE_CANVAS_RECONCILE_MS = 60_000;
  const LIVE_FEED_RECONCILE_MS = 120_000;
  const LIVE_RETRY_BASE_MS = 1_000;
  const LIVE_RETRY_MAX_MS = 30_000;
  const LIVE_MESSAGE_MAX_CHARS = 96;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const VOID = { r: 10, g: 12, b: 16 };
  const MOVE_SLOP = 10;
  /** @type {Map<number, Point>} */
  const pointers = new Map();
  let dragging = false;
  /** @type {Point | null} */
  let last = null;
  let dragDist = 0;
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /** @param {string} b64 */
  function decodeBoard(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** @param {string} hex */
  function hexRgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }

  function paint() {
    const ctx = boardEl.getContext("2d");
    if (!ctx || !board.length) return;
    const now = performance.now();
    const img = ctx.createImageData(size, size);
    const data = img.data;
    let anyFlash = false;

    for (let i = 0; i < board.length; i++) {
      const stored = board[i] | 0;
      const o = i * 4;
      let r = VOID.r;
      let g = VOID.g;
      let b = VOID.b;
      if (stored) {
        const ci = stored - 1;
        const hex = (palette && palette[ci]) || "#E50000";
        const c = hexRgb(hex);
        r = c.r;
        g = c.g;
        b = c.b;
      }
      const flashUntil = reduceMotion.matches ? 0 : flashes.get(i);
      if (flashUntil && flashUntil > now) {
        anyFlash = true;
        const k = Math.max(0, Math.min(1, 1 - (flashUntil - now) / 500));
        r = Math.round(255 * (1 - k) + r * k);
        g = Math.round(255 * (1 - k) + g * k);
        b = Math.round(255 * (1 - k) + b * k);
      } else if (flashUntil) {
        flashes.delete(i);
      }
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    applyTransform();
    if (anyFlash && !reduceMotion.matches) {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(paint);
    }
  }

  function clampPan() {
    const max = size * scale * 0.9;
    panX = Math.max(-max, Math.min(max, panX));
    panY = Math.max(-max, Math.min(max, panY));
  }

  function applyTransform() {
    clampPan();
    boardEl.style.width = `${size * scale}px`;
    boardEl.style.height = `${size * scale}px`;
    boardEl.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px))`;
  }

  function viewportSize() {
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) return { w: vv.width, h: vv.height };
    const rect = wrap.getBoundingClientRect();
    return {
      w: Math.max(1, rect.width || window.innerWidth || 1),
      h: Math.max(1, rect.height || window.innerHeight || 1),
    };
  }

  /** @param {boolean} force */
  function fitContain(force) {
    if (userAdjusted && !force) return;
    const { w, h } = viewportSize();
    const pad = Math.min(w, h) * 0.08;
    const contain = Math.min((w - pad) / size, (h - pad) / size);
    scale = Math.max(2, Math.floor(contain));
    panX = 0;
    panY = 0;
    hasFitted = true;
    applyTransform();
    saveView();
  }

  /** @param {number} s */
  function clampScale(s) {
    return Math.min(96, Math.max(2, s));
  }

  function saveView() {
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({ scale, panX, panY, userAdjusted, size, t: Date.now() })
      );
    } catch {
      /* private mode */
    }
  }

  function loadView() {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      if (!raw) return false;
      const v = JSON.parse(raw);
      if (!v || typeof v.scale !== "number") return false;
      if (v.size && v.size !== size) return false;
      scale = clampScale(v.scale);
      panX = Number(v.panX) || 0;
      panY = Number(v.panY) || 0;
      userAdjusted = Boolean(v.userAdjusted);
      hasFitted = true;
      applyTransform();
      return userAdjusted;
    } catch {
      return false;
    }
  }

  function markUserAdjusted() {
    userAdjusted = true;
    saveView();
  }

  /** @param {unknown} agent @param {number} x @param {number} y @param {unknown} goal */
  function spawnPainterTag(agent, x, y, goal) {
    const now = performance.now();
    nameTags.push({
      agent: String(agent || "agent").slice(0, 24),
      x,
      y,
      goal: goal ? String(goal).slice(0, 40) : "",
      until: now + 1800,
    });
    if (nameTags.length > 24) nameTags = nameTags.slice(-24);
    renderPainterTags();
  }

  function renderPainterTags() {
    let layer = document.getElementById("painter-tags");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "painter-tags";
      layer.className = "painter-tags";
      wrap.appendChild(layer);
    }
    const now = performance.now();
    nameTags = nameTags.filter((t) => t.until > now);
    const rect = boardEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    layer.innerHTML = "";
    for (const t of nameTags) {
      const el = document.createElement("div");
      el.className = "painter-tag";
      // Map board cell → screen inside wrap
      const px = rect.left - wrapRect.left + ((t.x + 0.5) / size) * rect.width;
      const py = rect.top - wrapRect.top + ((t.y + 0.5) / size) * rect.height;
      el.style.left = `${px}px`;
      el.style.top = `${py}px`;
      el.innerHTML = `<span class="brush" aria-hidden="true">🖌️</span><span class="who">${escapeHtml(t.agent)}</span>${
        t.goal ? `<span class="goal">${escapeHtml(t.goal)}</span>` : ""
      }`;
      layer.appendChild(el);
    }
    clearTimeout(painterTagTimer);
    if (nameTags.length) {
      const nextExpiry = Math.min(...nameTags.map((tag) => tag.until));
      painterTagTimer = setTimeout(renderPainterTags, Math.max(0, nextExpiry - performance.now()));
    }
  }

  function pointerDistance() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  /** @param {Uint8Array} next */
  function noteChanges(next) {
    if (reduceMotion.matches || !prevBoard || prevBoard.length !== next.length) {
      flashes.clear();
      return;
    }
    const now = performance.now();
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== prevBoard[i]) flashes.set(i, now + 500);
    }
  }

  const onMotionPreferenceChange = () => {
    if (!reduceMotion.matches) return;
    flashes.clear();
    cancelAnimationFrame(rafId);
    paint();
  };
  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", onMotionPreferenceChange);
  else reduceMotion.addListener?.(onMotionPreferenceChange);

  /** @param {FeedEntry[]} items */
  function pushTicker(items) {
    if (!items?.length) return;
    const fresh = [];
    for (const e of items.slice(0, 10)) {
      if (e.type !== "place") continue;
      if (typeof e.t === "number" && e.t > lastFeedSeen) fresh.push(e);
    }
    // Attribution is intentionally short-lived so art remains the primary view.
    if (lastFeedSeen > 0) {
      for (const e of fresh.slice(0, 8)) {
        if (typeof e.x === "number" && typeof e.y === "number") {
          spawnPainterTag(e.agent, e.x, e.y, e.goal);
        }
      }
    }
    const maxT = items.reduce((max, entry) => Math.max(max, typeof entry.t === "number" ? entry.t : 0), lastFeedSeen);
    lastFeedSeen = maxT;
  }

  /** @param {unknown} s */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** @param {string} msg */
  function showToast(msg) {
    if (!toast) return;
    toast.hidden = false;
    toast.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2200);
  }

  /** @param {AbortSignal} signal */
  async function fetchCanvas(signal) {
    const res = await fetch(`${API}/v1/canvas?scores=1`, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`canvas ${res.status}`);
    /** @type {unknown} */
    const raw = await res.json();
    if (!isRecord(raw)) return;
    /** @type {CanvasResponse} */
    const data = raw;
    if (data.ok !== true || typeof data.board !== "string" || typeof data.size !== "number" || !Number.isInteger(data.size) || data.size <= 0 || typeof data.version !== "number" || !Number.isInteger(data.version)) return;

    const nextSize = data.size;
    if (Array.isArray(data.palette) && data.palette.every((value) => typeof value === "string")) palette = data.palette;

    const sizeChanged = boardEl.width !== nextSize || boardEl.height !== nextSize;
    if (sizeChanged) {
      size = nextSize;
      boardEl.width = size;
      boardEl.height = size;
      version = -1;
      userAdjusted = false;
      hasFitted = false;
      prevBoard = null;
    } else {
      size = nextSize;
    }

    if (data.version !== version) {
      const next = decodeBoard(data.board);
      noteChanges(next);
      prevBoard = new Uint8Array(next);
      board = next;
      version = data.version;
      paint();
      if (!hasFitted || sizeChanged) fitContain(true);
      else applyTransform();
    }
    canvasReadThisVisibility = true;
  }

  /** @param {AbortSignal} signal */
  async function fetchFeed(signal) {
    const res = await fetch(`${API}/v1/feed`, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`feed ${res.status}`);
    /** @type {unknown} */
    const raw = await res.json();
    if (!isRecord(raw)) return;
    /** @type {FeedResponse} */
    const data = raw;
    if (data.ok === true && Array.isArray(data.feed)) {
      pushTicker(data.feed.filter(isRecord));
      feedReadThisVisibility = true;
    }
  }

  function liveUrl() {
    const url = new URL(API);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/live`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  function isLiveActive() {
    return isPollingActive() && typeof window.WebSocket === "function";
  }

  /** @param {LiveEvent | { t: "connected" | "disconnected" }} detail */
  function dispatchLive(detail) {
    if (typeof window.CustomEvent !== "function" || typeof window.dispatchEvent !== "function") return;
    window.dispatchEvent(new window.CustomEvent("grokplace:live", { detail }));
  }

  /** @param {unknown} value @returns {LiveEvent | null} */
  function parseLiveMessage(value) {
    if (typeof value !== "string" || value.length > LIVE_MESSAGE_MAX_CHARS) return null;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !keys.includes("t") || !keys.includes("v")) return null;
    if (parsed.t !== "ready" && parsed.t !== "canvas" && parsed.t !== "activity" && parsed.t !== "music") return null;
    if (typeof parsed.v !== "number" || !Number.isSafeInteger(parsed.v) || parsed.v < 0 || parsed.v > 2_147_483_647) return null;
    return { t: parsed.t, v: parsed.v };
  }

  function liveCanvasInterval() {
    return liveConnected ? LIVE_CANVAS_RECONCILE_MS : CANVAS_POLL_MS;
  }

  function liveFeedInterval() {
    return liveConnected ? LIVE_FEED_RECONCILE_MS : FEED_POLL_MS;
  }

  function liveRetryDelay() {
    const base = Math.min(LIVE_RETRY_MAX_MS, LIVE_RETRY_BASE_MS * (2 ** Math.min(Math.max(0, liveFailures - 1), 5)));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  function scheduleLiveReconnect() {
    if (!isLiveActive() || liveSocket || liveRetryTimer) return;
    liveRetryTimer = setTimeout(() => {
      liveRetryTimer = 0;
      ensureLiveSocket();
    }, liveRetryDelay());
  }

  function restoreFallbackPolling() {
    if (!isPollingActive()) return;
    if (canvasRequest) canvasRefreshQueued = true;
    else scheduleCanvasPoll(0);
    if (feedRequest) feedRefreshQueued = true;
    else scheduleFeedPoll(0);
  }

  /** @param {WebSocket | null} socket @param {boolean} reconnect */
  function disconnectLiveSocket(socket, reconnect) {
    if (socket && socket !== liveSocket) return;
    const wasConnected = liveConnected;
    liveSocket = null;
    liveConnected = false;
    if (wasConnected) {
      dispatchLive({ t: "disconnected" });
      restoreFallbackPolling();
    }
    if (reconnect && isLiveActive()) {
      liveFailures = Math.min(liveFailures + 1, 32);
      scheduleLiveReconnect();
    }
  }

  function closeLiveSocket() {
    clearTimeout(liveRetryTimer);
    liveRetryTimer = 0;
    const socket = liveSocket;
    disconnectLiveSocket(socket, false);
    try { socket?.close(1000, "hidden"); } catch { /* socket already closed */ }
  }

  /** @param {WebSocket} socket @param {unknown} value */
  function handleLiveMessage(socket, value) {
    if (socket !== liveSocket) return;
    const event = parseLiveMessage(value);
    if (!event) return;
    dispatchLive(event);
    if (event.t === "ready") {
      const resources = [];
      if (!canvasReadThisVisibility && !canvasRequest) resources.push("canvas");
      if (!feedReadThisVisibility && !feedRequest) resources.push("activity");
      if (resources.length) refreshPollingNow(resources);
    }
    else if (event.t === "canvas") refreshPollingNow(["canvas"]);
    else if (event.t === "activity") refreshPollingNow(["activity"]);
  }

  function ensureLiveSocket() {
    if (!isLiveActive() || liveSocket || liveRetryTimer) return;
    /** @type {WebSocket} */
    let socket;
    try {
      socket = new window.WebSocket(liveUrl());
    } catch {
      liveFailures = Math.min(liveFailures + 1, 32);
      scheduleLiveReconnect();
      return;
    }
    liveSocket = socket;
    socket.onopen = () => {
      if (socket !== liveSocket) return;
      liveConnected = true;
      liveFailures = 0;
      dispatchLive({ t: "connected" });
    };
    socket.onmessage = (event) => handleLiveMessage(socket, event?.data);
    socket.onerror = () => {
      if (socket !== liveSocket) return;
      try { socket.close(); } catch { /* close is best effort */ }
      disconnectLiveSocket(socket, true);
    };
    socket.onclose = () => disconnectLiveSocket(socket, true);
  }

  function isPollingActive() {
    return !pollingStopped && !pollingPaused && !document.hidden;
  }

  /** @param {number} base @param {number} failures */
  function backoffDelay(base, failures) {
    return Math.min(Math.max(POLL_BACKOFF_MAX_MS, base), base * (2 ** Math.min(failures, 3)));
  }

  /** @param {number} delay */
  function scheduleCanvasPoll(delay) {
    if (!isPollingActive()) return;
    clearTimeout(canvasTimer);
    canvasTimer = setTimeout(() => {
      canvasTimer = 0;
      void pollCanvas();
    }, delay);
  }

  /** @param {number} delay */
  function scheduleFeedPoll(delay) {
    if (!isPollingActive()) return;
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => {
      feedTimer = 0;
      void pollFeed();
    }, delay);
  }

  async function pollCanvas() {
    if (!isPollingActive()) return;
    if (canvasRequest) {
      canvasRefreshQueued = true;
      return;
    }
    const controller = new AbortController();
    canvasRequest = controller;
    try {
      await fetchCanvas(controller.signal);
      canvasFailures = 0;
      if (document.title.includes("reconnecting")) document.title = "grok/place · live mosaic";
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        canvasFailures++;
        document.title = "grok/place · reconnecting…";
      }
    } finally {
      if (canvasRequest === controller) canvasRequest = null;
      if (isPollingActive()) {
        const delay = canvasRefreshQueued ? 0 : backoffDelay(liveCanvasInterval(), canvasFailures);
        canvasRefreshQueued = false;
        scheduleCanvasPoll(delay);
      }
    }
  }

  async function pollFeed() {
    if (!isPollingActive()) return;
    if (feedRequest) {
      feedRefreshQueued = true;
      return;
    }
    const controller = new AbortController();
    feedRequest = controller;
    try {
      await fetchFeed(controller.signal);
      feedFailures = 0;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") feedFailures++;
    } finally {
      if (feedRequest === controller) feedRequest = null;
      if (isPollingActive()) {
        const delay = feedRefreshQueued ? 0 : backoffDelay(liveFeedInterval(), feedFailures);
        feedRefreshQueued = false;
        scheduleFeedPoll(delay);
      }
    }
  }

  /** @param {string[]} [resources] */
  function refreshPollingNow(resources = ["canvas", "activity"]) {
    if (!isPollingActive()) return;
    if (resources.includes("canvas")) {
      if (canvasRequest) canvasRefreshQueued = true;
      else scheduleCanvasPoll(0);
    }
    if (resources.includes("activity")) {
      if (feedRequest) feedRefreshQueued = true;
      else scheduleFeedPoll(0);
    }
  }

  function startPolling() {
    pollingStopped = false;
    pollingPaused = Boolean(document.hidden);
    refreshPollingNow();
    ensureLiveSocket();
  }

  function pausePolling() {
    pollingPaused = true;
    canvasRefreshQueued = false;
    feedRefreshQueued = false;
    canvasReadThisVisibility = false;
    feedReadThisVisibility = false;
    clearTimeout(canvasTimer);
    clearTimeout(feedTimer);
    canvasTimer = 0;
    feedTimer = 0;
    canvasRequest?.abort();
    feedRequest?.abort();
    closeLiveSocket();
  }

  function resumePolling() {
    if (pollingStopped || document.hidden || !pollingPaused) return;
    pollingPaused = false;
    refreshPollingNow();
    ensureLiveSocket();
  }

  function stopPolling() {
    pollingStopped = true;
    pausePolling();
  }

  // --- Gestures ---
  wrap.addEventListener(
    "pointerdown",
    (ev) => {
      if (ev.target instanceof Element && ev.target.closest(".float-hud, .share-btn, .sound-btn, .brand-logo")) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      try {
        wrap.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (pointers.size === 1) {
        dragging = true;
        dragDist = 0;
        last = { x: ev.clientX, y: ev.clientY };
      } else if (pointers.size >= 2) {
        dragging = false;
        pinchStartDist = pointerDistance() || 1;
        pinchStartScale = scale;
      }
    },
    { passive: true }
  );

  wrap.addEventListener(
    "pointermove",
    (ev) => {
      if (!pointers.has(ev.pointerId)) {
        if (ev.pointerType === "mouse") showCoord(ev);
        return;
      }
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size >= 2) {
        const dist = pointerDistance();
        if (pinchStartDist > 0 && dist > 0) {
          scale = clampScale(pinchStartScale * (dist / pinchStartDist));
          markUserAdjusted();
          applyTransform();
        }
        return;
      }
      if (!dragging || !last) return;
      const dx = ev.clientX - last.x;
      const dy = ev.clientY - last.y;
      dragDist += Math.hypot(dx, dy);
      if (dragDist < MOVE_SLOP) {
        last = { x: ev.clientX, y: ev.clientY };
        return;
      }
      markUserAdjusted();
      panX += dx;
      panY += dy;
      last = { x: ev.clientX, y: ev.clientY };
      applyTransform();
    },
    { passive: true }
  );

  /** @param {PointerEvent} ev */
  function endPointer(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchStartDist = 0;
    if (pointers.size === 0) {
      dragging = false;
      last = null;
    } else if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      dragging = true;
      last = { x: p.x, y: p.y };
    }
  }

  wrap.addEventListener("pointerup", endPointer);
  wrap.addEventListener("pointercancel", endPointer);
  wrap.addEventListener("pointerleave", (ev) => {
    if (ev.pointerType === "mouse") {
      endPointer(ev);
      if (coordTip) coordTip.hidden = true;
    }
  });

  // Zoom toward cursor (Maps-style)
  wrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const before = scale;
      const factor = ev.deltaY > 0 ? 0.9 : 1.1;
      const next = clampScale(scale * factor);
      if (next === before) return;
      // Keep point under cursor stable
      const rect = boardEl.getBoundingClientRect();
      const cx = ev.clientX - (rect.left + rect.width / 2);
      const cy = ev.clientY - (rect.top + rect.height / 2);
      const k = next / scale;
      panX = panX * k + cx * (1 - k);
      panY = panY * k + cy * (1 - k);
      scale = next;
      markUserAdjusted();
      applyTransform();
    },
    { passive: false }
  );

  wrap.addEventListener(
    "touchmove",
    (ev) => {
      ev.preventDefault();
    },
    { passive: false }
  );

  /** @param {number} clientX @param {number} clientY */
  function boardFromClient(clientX, clientY) {
    const rect = boardEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.floor(((clientX - rect.left) / rect.width) * size);
    const y = Math.floor(((clientY - rect.top) / rect.height) * size);
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    return { x, y };
  }

  /** @param {PointerEvent} ev */
  function showCoord(ev) {
    if (!coordTip) return;
    const p = boardFromClient(ev.clientX, ev.clientY);
    if (!p) {
      coordTip.hidden = true;
      return;
    }
    const idx = p.y * size + p.x;
    const stored = board[idx] | 0;
    const hex = stored ? palette[stored - 1] || "?" : "empty";
    coordTip.hidden = false;
    coordTip.textContent = `(${p.x}, ${p.y}) · ${hex}`;
    coordTip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - 140)}px`;
    coordTip.style.top = `${Math.min(ev.clientY + 14, window.innerHeight - 40)}px`;
  }

  // Keyboard power-user controls
  window.addEventListener("keydown", (ev) => {
    if (ev.target instanceof Element && /input|textarea|select/i.test(ev.target.tagName)) return;
    const step = Math.max(24, size * scale * 0.08);
    let handled = true;
    if (ev.key === "+" || ev.key === "=") {
      scale = clampScale(scale * 1.15);
      markUserAdjusted();
    } else if (ev.key === "-" || ev.key === "_") {
      scale = clampScale(scale * 0.87);
      markUserAdjusted();
    } else if (ev.key === "ArrowLeft") {
      panX += step;
      markUserAdjusted();
    } else if (ev.key === "ArrowRight") {
      panX -= step;
      markUserAdjusted();
    } else if (ev.key === "ArrowUp") {
      panY += step;
      markUserAdjusted();
    } else if (ev.key === "ArrowDown") {
      panY -= step;
      markUserAdjusted();
    } else if (ev.key === "r" || ev.key === "R" || ev.key === "0") {
      userAdjusted = false;
      fitContain(true);
      return;
    } else {
      handled = false;
    }
    if (handled) {
      ev.preventDefault();
      applyTransform();
    }
  });

  document.getElementById("brand-logo")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    userAdjusted = false;
    fitContain(true);
  });

  // Invite agent — Web Share first, then clipboard, then a readable fallback.
  shareBtn?.addEventListener("click", async () => {
    const text = [
      "You are the receiving agent for grok/place.",
      "Goal: [what to draw]",
      "",
      `1. Read ${API}/llms.txt.`,
      "2. Claim your agent name.",
      "3. Inspect the live board.",
      "4. Preserve coherent art; place up to 5 empty tiles.",
      "5. If the goal is blank, ask the human what to draw.",
    ].join("\n");
    let label = "";
    try {
      if (navigator.share) {
        await navigator.share({ title: "grok/place", text, url: API });
        showToast("Invite shared");
        label = "Shared!";
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast("Invite copied — paste it to your agent");
        label = "Copied!";
      } else {
        window.prompt("Copy this invite for your agent:", text);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(text);
        showToast("Invite copied — paste it to your agent");
        label = "Copied!";
      } catch {
        window.prompt("Copy this invite for your agent:", text);
      }
    }
    const labelEl = shareBtn.querySelector(".share-label");
    if (label && labelEl) {
      labelEl.textContent = label;
      setTimeout(() => { labelEl.textContent = "Invite agent"; }, 1600);
    }
  });

  window.addEventListener("resize", () => {
    if (!userAdjusted) fitContain(true);
    else applyTransform();
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => {
      if (!userAdjusted) fitContain(true);
    }, 120);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (!userAdjusted) fitContain(true);
      else applyTransform();
    });
  }

  // Restore saved camera (zoom/pan) so art view is not lost across reloads
  const restored = loadView();
  if (!restored) fitContain(true);
  startPolling();

  window.addEventListener("pagehide", () => {
    stopPolling();
    cancelAnimationFrame(rafId);
    clearTimeout(painterTagTimer);
    clearTimeout(toastTimer);
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) startPolling();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pausePolling();
    else resumePolling();
  });
  window.addEventListener("focus", () => {
    resumePolling();
    ensureLiveSocket();
  });

  window.grokplaceFitView = () => {
    userAdjusted = false;
    fitContain(true);
  };
})();
