/**
 * grok/place live mosaic watch experience.
 * Pan / pinch / keyboard. Place flashes and brief painter attribution.
 * Humans watch. Agents paint.
 */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ agent: string, x: number, y: number, color: string, goal: string, delayMs: number, angle: number, travelX: number, travelY: number, until: number }} PainterTag */
/** @typedef {{ x: number, y: number, color: string, delayMs: number, dx: number, dy: number, until: number }} PaintParticle */
/** @typedef {{ type?: unknown, t?: unknown, batchOrder?: unknown, agent?: unknown, x?: unknown, y?: unknown, c?: unknown, color?: unknown, goal?: unknown }} FeedEntry */
/** @typedef {{ t: "ready" | "canvas" | "activity" | "music", v: number }} LiveEvent */
/** @typedef {{ ok?: unknown, board?: unknown, size?: unknown, palette?: unknown, version?: unknown, planOverlay?: unknown }} CanvasResponse */
/** @typedef {{ ok?: unknown, feed?: unknown }} FeedResponse */
/** @typedef {{ x: number, y: number }} SelectedTile */
/** @typedef {"planned" | "completed" | "conflicting" | "protected" | "overwritten" | "reclaimed" | "remaining"} PlanOverlayState */
/** @typedef {{ x: number, y: number, state: PlanOverlayState }} ActivePlanCell */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const boardNode = /** @type {HTMLCanvasElement | null} */ (document.getElementById("board"));
  const planOverlayNode = /** @type {HTMLCanvasElement | null} */ (document.getElementById("plan-overlay-canvas"));
  const wrapNode = document.getElementById("canvas-wrap");
  const coordTip = document.getElementById("coord-tip");
  const shareBtn = document.getElementById("share-btn");
  const followBtn = document.getElementById("follow-btn");
  const toast = document.getElementById("toast");
  const livePill = document.getElementById("live-pill");
  const liveText = document.getElementById("live-text");
  const activityTicker = document.getElementById("activity-ticker");
  const tickerTrack = document.getElementById("ticker-track");
  const tickerToggle = document.getElementById("ticker-toggle");
  const tileInspector = document.getElementById("tile-inspector");
  const tileInspectorTitle = document.getElementById("tile-inspector-title");
  const tileInspectorState = document.getElementById("tile-inspector-state");
  const tileInspectorClose = document.getElementById("tile-inspector-close");
  const tileInspectorRetry = document.getElementById("tile-inspector-retry");
  const selectedCellMarker = document.getElementById("selected-cell-marker");
  const planOverlay = document.getElementById("plan-overlay");
  const planOverlayTitle = document.getElementById("plan-overlay-title");
  const planOverlayVersion = document.getElementById("plan-overlay-version");
  const planOverlayProgress = document.getElementById("plan-overlay-progress");
  if (!boardNode || !wrapNode) return;
  const boardEl = boardNode;
  const planOverlayEl = planOverlayNode;
  const wrap = wrapNode;

  /** @type {string[]} */
  let palette = [];
  let size = 192;
  let version = -1;
  let board = new Uint8Array(size * size);
  /** @type {ActivePlanCell[]} */
  let activePlanCells = [];
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
  /** @type {PaintParticle[]} */
  let paintParticles = [];
  let lastFeedSeen = 0;
  let tickerHidden = false;
  let tickerFocusPaused = false;
  let followLatest = false;
  let rafId = 0;
  let painterTagTimer = 0;
  let particleTimer = 0;
  let canvasTimer = 0;
  let feedTimer = 0;
  let toastTimer = 0;
  /** @type {SelectedTile | null} */
  let selectedTile = null;
  /** @type {AbortController | null} */
  let tileRequest = null;
  let tileSelectionVersion = 0;
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
  let canvasRetryAfterMs = 0;
  let feedRetryAfterMs = 0;
  let canvasRetryJitter = false;
  let feedRetryJitter = false;
  let canvasRetryNotBefore = 0;
  let feedRetryNotBefore = 0;
  let canvasCadenceNotBefore = 0;
  let feedCadenceNotBefore = 0;
  let canvasReadThisVisibility = false;
  let feedReadThisVisibility = false;
  let canvasRefreshQueued = false;
  let feedRefreshQueued = false;
  const VIEW_KEY = "grokplace-view-v1";
  const TICKER_HIDDEN_KEY = "grokplace-activity-ticker-hidden-v1";
  const TICKER_ITEMS_MAX = 12;
  const BRUSH_TAGS_MAX = 24;
  const PAINT_PARTICLES_MAX = 40;
  // Disconnected viewers retain this critic-reviewed 12/min fallback budget.
  const CANVAS_POLL_MS = 12_000;
  const FEED_POLL_MS = 30_000;
  const POLL_BACKOFF_MAX_MS = 60_000;
  const MAX_TIMER_DELAY_MS = 2_147_000_000;
  const LIVE_CANVAS_RECONCILE_MS = 60_000;
  const LIVE_FEED_RECONCILE_MS = 120_000;
  const LIVE_RETRY_BASE_MS = 1_000;
  const LIVE_RETRY_MAX_MS = 30_000;
  const LIVE_MESSAGE_MAX_CHARS = 96;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  /** @type {PlanOverlayState[]} */
  const PLAN_STATES = ["planned", "completed", "conflicting", "protected", "overwritten", "reclaimed", "remaining"];
  /** @type {Record<PlanOverlayState, string>} */
  const PLAN_STATE_COLORS = {
    planned: "#FFFFFF",
    completed: "#51E9F4",
    conflicting: "#FFA800",
    protected: "#CF6EE4",
    overwritten: "#E50000",
    reclaimed: "#00A368",
    remaining: "#94A3B8",
  };

  /** @param {unknown} value @returns {value is PlanOverlayState} */
  function isPlanOverlayState(value) {
    return typeof value === "string" && PLAN_STATES.includes(/** @type {PlanOverlayState} */ (value));
  }

  const VOID = { r: 10, g: 12, b: 16 };
  const MOVE_SLOP = 10;
  /** @type {Map<number, Point>} */
  const pointers = new Map();
  let dragging = false;
  let gestureHadMultiple = false;
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
    paintPlanOverlay();
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
    const width = `${size * scale}px`;
    const transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px))`;
    boardEl.style.width = width;
    boardEl.style.height = width;
    boardEl.style.transform = transform;
    if (planOverlayEl) {
      planOverlayEl.style.width = width;
      planOverlayEl.style.height = width;
      planOverlayEl.style.transform = transform;
    }
    renderSelectedCellMarker();
  }

  function renderSelectedCellMarker() {
    if (!selectedCellMarker) return;
    if (!selectedTile) {
      selectedCellMarker.hidden = true;
      return;
    }
    const rect = boardEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      selectedCellMarker.hidden = true;
      return;
    }
    const cellWidth = rect.width / size;
    const cellHeight = rect.height / size;
    selectedCellMarker.hidden = false;
    selectedCellMarker.style.left = `${rect.left - wrapRect.left + selectedTile.x * cellWidth}px`;
    selectedCellMarker.style.top = `${rect.top - wrapRect.top + selectedTile.y * cellHeight}px`;
    selectedCellMarker.style.width = `${cellWidth}px`;
    selectedCellMarker.style.height = `${cellHeight}px`;
  }

  function paintPlanOverlay() {
    if (!planOverlayEl) return;
    const ctx = planOverlayEl.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, planOverlayEl.width, planOverlayEl.height);
    for (const cell of activePlanCells) {
      const color = PLAN_STATE_COLORS[cell.state] || PLAN_STATE_COLORS.planned;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = cell.state === "remaining" ? 0.78 : 0.98;
      ctx.lineWidth = 0.18;
      ctx.setLineDash(cell.state === "planned" || cell.state === "remaining" ? [0.28, 0.18] : []);
      ctx.strokeRect(cell.x + 0.09, cell.y + 0.09, 0.82, 0.82);
      ctx.restore();
    }
  }

  /** @param {unknown} raw */
  function renderPlanOverlay(raw) {
    if (!isRecord(raw) || !isRecord(raw.plan) || !Array.isArray(raw.cells)) {
      activePlanCells = [];
      if (planOverlay) planOverlay.hidden = true;
      if (planOverlayEl) planOverlayEl.hidden = true;
      paintPlanOverlay();
      return;
    }
    const plan = raw.plan;
    const title = typeof plan.title === "string" ? plan.title.slice(0, 80) : "Active plan";
    const version = typeof plan.version === "number" && Number.isInteger(plan.version) ? plan.version : null;
    activePlanCells = raw.cells
      .filter((cell) => isRecord(cell)
        && typeof cell.x === "number" && Number.isInteger(cell.x) && cell.x >= 0 && cell.x < size
        && typeof cell.y === "number" && Number.isInteger(cell.y) && cell.y >= 0 && cell.y < size
        && isPlanOverlayState(cell.state))
      .slice(0, 512)
      .map((cell) => ({
        x: /** @type {number} */ (cell.x),
        y: /** @type {number} */ (cell.y),
        state: /** @type {PlanOverlayState} */ (cell.state),
      }));
    if (planOverlayTitle) planOverlayTitle.textContent = title;
    if (planOverlayVersion) planOverlayVersion.textContent = version === null ? "" : `v${version}`;
    const progress = isRecord(raw.progress) ? raw.progress : {};
    const complete = typeof progress.complete === "number" ? progress.complete : 0;
    const total = typeof progress.total === "number" ? progress.total : activePlanCells.length;
    const remaining = typeof progress.remaining === "number" ? progress.remaining : 0;
    if (planOverlayProgress) planOverlayProgress.textContent = `${complete}/${total} complete · ${remaining} remaining`;
    const states = isRecord(raw.states) ? raw.states : {};
    for (const state of PLAN_STATES) {
      const field = document.getElementById(`plan-state-${state}`);
      if (field) field.textContent = typeof states[state] === "number" ? String(states[state]) : "0";
    }
    if (planOverlay) planOverlay.hidden = false;
    if (planOverlayEl) planOverlayEl.hidden = false;
    paintPlanOverlay();
    applyTransform();
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
    if (followLatest) setFollowLatest(false);
    saveView();
  }

  /** @param {unknown} agent @param {number} x @param {number} y @param {unknown} goal @param {string} color @param {number} delayMs @param {{ angle: number, travelX: number, travelY: number }} motion */
  function spawnPainterTag(agent, x, y, goal, color, delayMs, motion) {
    const now = performance.now();
    nameTags.push({
      agent: String(agent || "agent").slice(0, 24),
      x,
      y,
      color: /^#[0-9A-F]{6}$/.test(color) ? color : "#FFFFFF",
      goal: goal ? String(goal).slice(0, 40) : "",
      delayMs: Math.max(0, Math.min(630, delayMs)),
      angle: Number.isFinite(motion?.angle) ? motion.angle : -28,
      travelX: Number.isFinite(motion?.travelX) ? motion.travelX : -0.62,
      travelY: Number.isFinite(motion?.travelY) ? motion.travelY : -0.24,
      until: now + 2000 + Math.max(0, Math.min(630, delayMs)),
    });
    if (nameTags.length > 24) nameTags = nameTags.slice(-BRUSH_TAGS_MAX);
    renderPainterTags();
  }

  /** @param {number} x @param {number} y @param {string} color @param {number} delayMs */
  function spawnPaintParticles(x, y, color, delayMs) {
    if (reduceMotion.matches) return;
    const now = performance.now();
    const directions = [[-11, -8], [10, -7], [-8, 10], [9, 9], [0, -13]];
    for (const [dx, dy] of directions) {
      paintParticles.push({
        x,
        y,
        color: /^#[0-9A-F]{6}$/.test(color) ? color : "#FFFFFF",
        delayMs: Math.max(0, Math.min(630, delayMs)),
        dx,
        dy,
        until: now + 620 + Math.max(0, Math.min(630, delayMs)),
      });
    }
    if (paintParticles.length > PAINT_PARTICLES_MAX) paintParticles = paintParticles.slice(-PAINT_PARTICLES_MAX);
    renderPaintParticles();
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
      el.style.setProperty("--brush-color", t.color);
      el.style.setProperty("--brush-delay", `${t.delayMs}ms`);
      el.style.setProperty("--brush-angle", `${t.angle}deg`);
      el.style.setProperty("--brush-travel-x", `${t.travelX}rem`);
      el.style.setProperty("--brush-travel-y", `${t.travelY}rem`);
      el.innerHTML = `<span class="brush-tool" aria-hidden="true"><span class="brush-handle"><span class="brush-grain"></span></span><span class="brush-ferrule"><span class="brush-ferrule-band"></span></span><span class="brush-bristles"><span class="brush-bristle"></span><span class="brush-bristle"></span><span class="brush-bristle"></span></span><span class="brush-paint-tip"></span></span><span class="who">${escapeHtml(t.agent)}</span>${
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

  function clearPainterTags() {
    nameTags = [];
    clearTimeout(painterTagTimer);
    painterTagTimer = 0;
    const layer = document.getElementById("painter-tags");
    if (layer) layer.innerHTML = "";
  }

  function renderPaintParticles() {
    let layer = document.getElementById("paint-particles");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "paint-particles";
      layer.className = "paint-particles";
      wrap.appendChild(layer);
    }
    const now = performance.now();
    paintParticles = paintParticles.filter((particle) => particle.until > now);
    const rect = boardEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    layer.innerHTML = "";
    for (const particle of paintParticles) {
      const el = document.createElement("span");
      el.className = "paint-particle";
      el.style.left = `${rect.left - wrapRect.left + ((particle.x + 0.5) / size) * rect.width}px`;
      el.style.top = `${rect.top - wrapRect.top + ((particle.y + 0.5) / size) * rect.height}px`;
      el.style.setProperty("--particle-color", particle.color);
      el.style.setProperty("--particle-delay", `${particle.delayMs}ms`);
      el.style.setProperty("--particle-x", `${particle.dx}px`);
      el.style.setProperty("--particle-y", `${particle.dy}px`);
      layer.appendChild(el);
    }
    clearTimeout(particleTimer);
    if (paintParticles.length) {
      const nextExpiry = Math.min(...paintParticles.map((particle) => particle.until));
      particleTimer = setTimeout(renderPaintParticles, Math.max(0, nextExpiry - performance.now()));
    }
  }

  function clearPaintParticles() {
    paintParticles = [];
    clearTimeout(particleTimer);
    particleTimer = 0;
    const layer = document.getElementById("paint-particles");
    if (layer) layer.innerHTML = "";
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
    syncTickerMotion();
    if (!reduceMotion.matches) return;
    flashes.clear();
    clearPaintParticles();
    cancelAnimationFrame(rafId);
    paint();
  };
  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", onMotionPreferenceChange);
  else reduceMotion.addListener?.(onMotionPreferenceChange);

  function syncTickerMotion() {
    activityTicker?.classList.toggle("is-paused", tickerHidden || tickerFocusPaused || document.hidden || reduceMotion.matches);
  }

  /** @param {boolean} hidden */
  function setTickerHidden(hidden) {
    tickerHidden = hidden;
    activityTicker?.classList.toggle("is-hidden", hidden);
    document.body?.classList.toggle("ticker-hidden", hidden);
    tickerToggle?.setAttribute("aria-pressed", String(hidden));
    tickerToggle?.setAttribute("aria-label", hidden ? "Show activity" : "Hide activity");
    tickerToggle?.setAttribute("title", hidden ? "Show activity" : "Hide activity");
    const icon = tickerToggle?.querySelector(".ticker-toggle-icon");
    if (icon) icon.textContent = hidden ? "+" : "×";
    try {
      localStorage.setItem(TICKER_HIDDEN_KEY, hidden ? "1" : "0");
    } catch {
      /* private mode */
    }
    syncTickerMotion();
  }

  function loadTickerState() {
    try {
      setTickerHidden(localStorage.getItem(TICKER_HIDDEN_KEY) === "1");
    } catch {
      setTickerHidden(false);
    }
  }

  /** @param {boolean} next */
  function setFollowLatest(next) {
    followLatest = Boolean(next);
    followBtn?.classList.toggle("is-on", followLatest);
    followBtn?.setAttribute("aria-pressed", String(followLatest));
    followBtn?.setAttribute("aria-label", followLatest ? "Stop following latest activity" : "Follow latest activity");
    followBtn?.setAttribute("title", followLatest ? "Stop following latest activity" : "Follow latest activity");
    const label = followBtn?.querySelector(".follow-label");
    if (label) label.textContent = followLatest ? "Following" : "Follow";
  }

  function loadFollowState() {
    setFollowLatest(false);
  }

  /** @param {{ x: number, y: number }} entry */
  function followActivity(entry) {
    if (!followLatest) return;
    scale = clampScale(Math.max(scale, 8));
    panX = (size / 2 - (entry.x + 0.5)) * scale;
    panY = (size / 2 - (entry.y + 0.5)) * scale;
    userAdjusted = true;
    saveView();
    if (!reduceMotion.matches) flashes.set(entry.y * size + entry.x, performance.now() + 500);
    paint();
  }

  /** @param {unknown} raw */
  function tickerEntry(raw) {
    if (!isRecord(raw) || !["place", "protect", "overwrite", "reclaim", "restore", "vote"].includes(String(raw.type))) return null;
    const x = raw.x;
    const y = raw.y;
    const agent = raw.agent;
    if (typeof x !== "number" || !Number.isSafeInteger(x) || typeof y !== "number" || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= size || y >= size || typeof agent !== "string" || !agent) return null;
    const fromColorIndex = typeof raw.c === "number" && Number.isSafeInteger(raw.c) && typeof palette[raw.c] === "string" ? palette[raw.c] : "";
    const color = typeof raw.color === "string" ? raw.color.toUpperCase() : fromColorIndex.toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(color)) return null;
    const goal = typeof raw.goal === "string" ? raw.goal.slice(0, 200) : "";
    const t = typeof raw.t === "number" && Number.isFinite(raw.t) ? raw.t : 0;
    const batchOrder = typeof raw.batchOrder === "number" && Number.isSafeInteger(raw.batchOrder) && raw.batchOrder >= 0 ? raw.batchOrder : 0;
    return { type: String(raw.type), x, y, agent: agent.slice(0, 32), color, goal, t, batchOrder };
  }

  /** @param {{ type: string, x: number, y: number, agent: string, color: string, goal: string, t: number }} entry @param {boolean} duplicate */
  function tickerItemMarkup(entry, duplicate) {
    const region = `R${Math.floor(entry.y / 16) + 1}C${Math.floor(entry.x / 16) + 1}`;
    const action = entry.type === "overwrite" ? "overwrote" : entry.type === "protect" ? "protected" : entry.type === "reclaim" ? "reclaimed" : entry.type === "restore" ? "restored" : entry.type === "vote" ? "voted" : "placed";
    const label = `${entry.agent} ${action} ${entry.color} at (${entry.x}, ${entry.y}), ${region}${entry.goal ? `, goal: ${entry.goal}` : ""}`;
    const content = `<span class="ticker-swatch" style="--ticker-color:${entry.color}" aria-hidden="true"></span><span class="ticker-primary"><span class="ticker-agent">${escapeHtml(entry.agent)}</span> ${action}</span><span class="ticker-secondary">${entry.color} · (${entry.x}, ${entry.y}) · ${region}${entry.goal ? ` · <span class="ticker-goal">${escapeHtml(entry.goal)}</span>` : ""}</span>`;
    if (duplicate) return `<span class="ticker-item" aria-hidden="true">${content}</span>`;
    return `<button type="button" class="ticker-item" role="listitem" data-x="${entry.x}" data-y="${entry.y}" aria-label="${escapeHtml(label)}">${content}</button>`;
  }

  /** @param {FeedEntry[]} items */
  function renderActivityTicker(items) {
    if (!tickerTrack) return;
    const seen = new Set();
    const entries = [];
    for (const raw of items) {
      const entry = tickerEntry(raw);
      if (!entry) continue;
      const key = `${entry.t}:${entry.type}:${entry.agent}:${entry.x}:${entry.y}:${entry.color}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
      if (entries.length >= TICKER_ITEMS_MAX) break;
    }
    if (!entries.length) {
      tickerTrack.innerHTML = "";
      return;
    }
    const firstPass = entries.map((entry) => tickerItemMarkup(entry, false)).join("");
    const secondPass = entries.map((entry) => tickerItemMarkup(entry, true)).join("");
    tickerTrack.innerHTML = `${firstPass}${secondPass}`;
  }

  /** @param {number} x @param {number} y */
  function focusTickerTile(x, y) {
    scale = clampScale(Math.max(scale, 8));
    panX = (size / 2 - (x + 0.5)) * scale;
    panY = (size / 2 - (y + 0.5)) * scale;
    markUserAdjusted();
    if (!reduceMotion.matches) flashes.set(y * size + x, performance.now() + 500);
    paint();
    if (typeof boardEl.focus === "function") boardEl.focus({ preventScroll: true });
  }

  tickerToggle?.addEventListener("click", () => setTickerHidden(!tickerHidden));
  followBtn?.addEventListener("click", () => setFollowLatest(!followLatest));
  activityTicker?.addEventListener("focusin", () => {
    tickerFocusPaused = true;
    syncTickerMotion();
  });
  activityTicker?.addEventListener("focusout", () => {
    tickerFocusPaused = false;
    syncTickerMotion();
  });
  tickerTrack?.addEventListener("click", (event) => {
    const eventTarget = /** @type {{ closest?: (selector: string) => Element | null } | null} */ (event.target);
    const target = eventTarget?.closest?.(".ticker-item[data-x][data-y]") || null;
    if (!target) return;
    const x = Number(target.getAttribute("data-x"));
    const y = Number(target.getAttribute("data-y"));
    if (Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0 && x < size && y < size) focusTickerTile(x, y);
  });

  /** @param {FeedEntry[]} items */
  function pushTicker(items) {
    renderActivityTicker(items);
    if (!items?.length) return;
    const fresh = [];
    for (const e of items.slice(0, 10)) {
      const entry = tickerEntry(e);
      if (!entry || !["place", "reclaim", "restore"].includes(entry.type)) continue;
      if (entry.t > lastFeedSeen) fresh.push(entry);
    }
    // Attribution is intentionally short-lived so art remains the primary view.
    if (lastFeedSeen > 0) {
      const ordered = fresh.sort((a, b) => a.t - b.t || a.batchOrder - b.batchOrder).slice(-8);
      for (const [index, entry] of ordered.entries()) {
        const previous = ordered[index - 1];
        const dx = previous ? entry.x - previous.x : 1;
        const dy = previous ? entry.y - previous.y : -0.45;
        const length = Math.max(1, Math.hypot(dx, dy));
        const motion = {
          angle: Math.round(Math.atan2(dy, dx) * 180 / Math.PI),
          travelX: -Math.max(-1, Math.min(1, dx / length)) * 0.72,
          travelY: -Math.max(-1, Math.min(1, dy / length)) * 0.42,
        };
        spawnPainterTag(entry.agent, entry.x, entry.y, entry.goal, entry.color, index * 90, motion);
        spawnPaintParticles(entry.x, entry.y, entry.color, index * 90);
      }
      const newest = ordered[ordered.length - 1];
      if (newest) followActivity(newest);
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

  /** @param {string} id @param {string} value @param {boolean} [visible] */
  function setInspectorField(id, value, visible = true) {
    const field = document.getElementById(id);
    if (!field) return;
    field.textContent = value || "—";
    const row = field.parentElement;
    if (row) row.hidden = !visible;
  }

  /** @param {boolean} reconnecting */
  function setLiveStatus(reconnecting) {
    livePill?.classList.toggle("is-reconnecting", reconnecting);
    livePill?.setAttribute("aria-label", reconnecting ? "Canvas reconnecting; last mosaic remains visible" : "Live canvas");
    livePill?.setAttribute("title", reconnecting ? "Reconnecting" : "Live");
    if (liveText) liveText.textContent = reconnecting ? "RECONNECTING" : "LIVE";
  }

  /** @param {SelectedTile} selected @param {string} state @param {boolean} [retryAvailable] */
  function showInspectorState(selected, state, retryAvailable = false) {
    if (!tileInspector) return;
    tileInspector.hidden = false;
    document.body?.classList.toggle("inspector-open", true);
    if (tileInspectorTitle) tileInspectorTitle.textContent = `Tile (${selected.x}, ${selected.y})`;
    if (tileInspectorState) tileInspectorState.textContent = state;
    if (tileInspectorRetry) tileInspectorRetry.hidden = !retryAvailable;
  }

  /** @param {unknown} raw @param {SelectedTile} selected */
  function renderTileInspector(raw, selected) {
    if (!isRecord(raw) || !isRecord(raw.tile)) {
      showInspectorState(selected, "Details unavailable", true);
      return;
    }
    const tile = raw.tile;
    const state = tile.state === "empty" ? "Empty" : tile.state === "painted" ? "Painted" : "Details unavailable";
    showInspectorState(selected, state, state === "Details unavailable");
    const protection = isRecord(tile.protection) ? tile.protection : {};
    const protectedTile = protection.protected === true;
    const score = typeof protection.score === "number" ? protection.score : 0;
    const record = isRecord(protection.record) ? protection.record : null;
    const until = record && typeof record.expiresAt === "number" ? new Date(record.expiresAt).toISOString() : "";
    setInspectorField("tile-inspector-protection", protectedTile ? `Protected until ${until || "unknown"}` : `Open (vote score ${score})`);
    if (tile.state === "empty") {
      setInspectorField("tile-inspector-color", "None");
      setInspectorField("tile-inspector-agent", "", false);
      setInspectorField("tile-inspector-time", "", false);
      setInspectorField("tile-inspector-goal", "", false);
      setInspectorField("tile-inspector-plan", "", false);
      return;
    }
    const color = typeof tile.color === "string" ? tile.color : "Unknown";
    setInspectorField("tile-inspector-color", color);
    const placement = isRecord(tile.placement) ? tile.placement : {};
    const agent = typeof placement.agent === "string" ? placement.agent : "Unknown";
    setInspectorField("tile-inspector-agent", agent);
    const placedAt = typeof placement.placedAtIso === "string" ? placement.placedAtIso : "Unavailable";
    setInspectorField("tile-inspector-time", placedAt);
    const goal = typeof placement.goal === "string" && placement.goal ? placement.goal : "None";
    setInspectorField("tile-inspector-goal", goal);
    const plan = isRecord(placement.plan) ? placement.plan : null;
    const planId = plan && typeof plan.id === "string" ? plan.id : "";
    const planTitle = plan && typeof plan.title === "string" ? plan.title : "";
    setInspectorField("tile-inspector-plan", planId ? (planTitle ? `${planTitle} (${planId})` : planId) : "None");
    if (placement.provenance === "legacy_unavailable" && tileInspectorState) tileInspectorState.textContent = "Painted (legacy details unavailable)";
  }

  /** @param {SelectedTile} selected */
  async function fetchSelectedTile(selected) {
    tileRequest?.abort();
    const controller = new AbortController();
    tileRequest = controller;
    const selectionVersion = ++tileSelectionVersion;
    try {
      const params = new URLSearchParams({ x: String(selected.x), y: String(selected.y) });
      const res = await fetch(`${API}/v1/tile?${params}`, { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error(`tile ${res.status}`);
      const raw = await res.json();
      if (selectedTile !== selected || selectionVersion !== tileSelectionVersion) return;
      renderTileInspector(raw, selected);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        if (selectedTile === selected && selectionVersion === tileSelectionVersion) showInspectorState(selected, "Details unavailable", true);
      }
    } finally {
      if (tileRequest === controller) tileRequest = null;
    }
  }

  /** @param {SelectedTile} selected */
  function selectTile(selected) {
    selectedTile = selected;
    renderSelectedCellMarker();
    if (typeof boardEl.focus === "function") boardEl.focus({ preventScroll: true });
    showInspectorState(selected, "Loading");
    void fetchSelectedTile(selected);
  }

  function clearSelectedTile() {
    selectedTile = null;
    tileSelectionVersion++;
    tileRequest?.abort();
    tileRequest = null;
    if (tileInspector) tileInspector.hidden = true;
    if (tileInspectorRetry) tileInspectorRetry.hidden = true;
    document.body?.classList.toggle("inspector-open", false);
    renderSelectedCellMarker();
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
    if (!res.ok) throw requestError("canvas", res);
    /** @type {unknown} */
    const raw = await res.json();
    if (!isRecord(raw)) throw new Error("canvas response invalid");
    /** @type {CanvasResponse} */
    const data = raw;
    if (data.ok !== true || typeof data.board !== "string" || typeof data.size !== "number" || !Number.isInteger(data.size) || data.size <= 0 || typeof data.version !== "number" || !Number.isInteger(data.version)) throw new Error("canvas response invalid");

    const nextSize = data.size;
    if (Array.isArray(data.palette) && data.palette.every((value) => typeof value === "string")) palette = data.palette;

    const sizeChanged = boardEl.width !== nextSize || boardEl.height !== nextSize;
    if (sizeChanged) {
      size = nextSize;
      boardEl.width = size;
      boardEl.height = size;
      if (planOverlayEl) {
        planOverlayEl.width = size;
        planOverlayEl.height = size;
      }
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
      if (selectedTile) void fetchSelectedTile(selectedTile);
    }
    renderPlanOverlay(data.planOverlay);
    canvasReadThisVisibility = true;
  }

  /** @param {AbortSignal} signal */
  async function fetchFeed(signal) {
    const res = await fetch(`${API}/v1/feed`, { cache: "no-store", signal });
    if (!res.ok) throw requestError("feed", res);
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

  /** @param {Response | { headers?: { get?: (name: string) => string | null } }} response */
  function retryAfterMs(response) {
    const value = response.headers?.get?.("Retry-After")?.trim() || "";
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Number.MAX_SAFE_INTEGER - Date.now(), Math.ceil(seconds * 1000));
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
  }

  /** @param {string} resource @param {Response | { status?: number, headers?: { get?: (name: string) => string | null } }} response */
  function requestError(resource, response) {
    const error = new Error(`${resource} ${response.status || 0}`);
    const status = response.status || 0;
    if (status === 429 || status >= 500 && status <= 599) {
      Object.assign(error, { retryAfterMs: retryAfterMs(response), retryJitter: true });
    }
    return error;
  }

  /** @param {unknown} error */
  function retryPolicyFromError(error) {
    const retry = error && typeof error === "object"
      ? /** @type {{ retryAfterMs?: unknown, retryJitter?: unknown }} */ (error)
      : {};
    const value = Number(retry.retryAfterMs);
    return {
      retryAfterMs: Number.isFinite(value) && value > 0 ? value : 0,
      jitter: retry.retryJitter === true,
    };
  }

  /** @param {number} base @param {number} failures @param {number} [serverRetryAfterMs] @param {boolean} [jitter] */
  function backoffDelay(base, failures, serverRetryAfterMs = 0, jitter = false) {
    if (failures <= 0) return base;
    const exponential = Math.min(POLL_BACKOFF_MAX_MS, base * (2 ** Math.min(failures, 3)));
    if (!jitter) return Math.max(serverRetryAfterMs, exponential);
    const jittered = Math.min(POLL_BACKOFF_MAX_MS, Math.round(exponential * (0.8 + Math.random() * 0.4)));
    return Math.max(serverRetryAfterMs, jittered);
  }

  /** @param {number} delay */
  function scheduleCanvasPoll(delay) {
    if (!isPollingActive()) return;
    const gateDelay = Math.max(0, canvasRetryNotBefore - Date.now(), canvasCadenceNotBefore - Date.now());
    if (gateDelay > 0 && canvasTimer) return;
    clearTimeout(canvasTimer);
    canvasTimer = setTimeout(() => {
      canvasTimer = 0;
      if (canvasRetryNotBefore > Date.now()) {
        scheduleCanvasPoll(0);
        return;
      }
      canvasRetryNotBefore = 0;
      void pollCanvas();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(delay, gateDelay)));
  }

  /** @param {number} delay */
  function scheduleFeedPoll(delay) {
    if (!isPollingActive()) return;
    const gateDelay = Math.max(0, feedRetryNotBefore - Date.now(), feedCadenceNotBefore - Date.now());
    if (gateDelay > 0 && feedTimer) return;
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => {
      feedTimer = 0;
      if (feedRetryNotBefore > Date.now()) {
        scheduleFeedPoll(0);
        return;
      }
      feedRetryNotBefore = 0;
      void pollFeed();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(delay, gateDelay)));
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
      canvasRetryNotBefore = 0;
      canvasCadenceNotBefore = Date.now() + liveCanvasInterval();
      setLiveStatus(false);
      if (document.title.includes("reconnecting")) document.title = "grok/place · live mosaic";
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        canvasFailures++;
        const retry = retryPolicyFromError(error);
        canvasRetryAfterMs = retry.retryAfterMs;
        canvasRetryJitter = retry.jitter;
        setLiveStatus(true);
        document.title = "grok/place · reconnecting…";
      }
    } finally {
      if (canvasRequest === controller) canvasRequest = null;
      if (isPollingActive()) {
        const failureDelay = backoffDelay(liveCanvasInterval(), canvasFailures, canvasRetryAfterMs, canvasRetryJitter);
        if (canvasFailures > 0) canvasRetryNotBefore = Math.max(canvasRetryNotBefore, Date.now() + failureDelay);
        const delay = canvasRefreshQueued ? 0 : failureDelay;
        canvasRefreshQueued = false;
        canvasRetryAfterMs = 0;
        canvasRetryJitter = false;
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
      feedRetryNotBefore = 0;
      feedCadenceNotBefore = Date.now() + liveFeedInterval();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        feedFailures++;
        const retry = retryPolicyFromError(error);
        feedRetryAfterMs = retry.retryAfterMs;
        feedRetryJitter = retry.jitter;
      }
    } finally {
      if (feedRequest === controller) feedRequest = null;
      if (isPollingActive()) {
        const failureDelay = backoffDelay(liveFeedInterval(), feedFailures, feedRetryAfterMs, feedRetryJitter);
        if (feedFailures > 0) feedRetryNotBefore = Math.max(feedRetryNotBefore, Date.now() + failureDelay);
        const delay = feedRefreshQueued ? 0 : failureDelay;
        feedRefreshQueued = false;
        feedRetryAfterMs = 0;
        feedRetryJitter = false;
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
    canvasCadenceNotBefore = 0;
    feedCadenceNotBefore = 0;
    clearTimeout(canvasTimer);
    clearTimeout(feedTimer);
    canvasTimer = 0;
    feedTimer = 0;
    canvasRequest?.abort();
    feedRequest?.abort();
    tileRequest?.abort();
    closeLiveSocket();
    clearPainterTags();
    clearPaintParticles();
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
        gestureHadMultiple = false;
        dragDist = 0;
        last = { x: ev.clientX, y: ev.clientY };
      } else if (pointers.size >= 2) {
        dragging = false;
        gestureHadMultiple = true;
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
    const selectOnRelease = ev.type === "pointerup" && pointers.size === 1 && !gestureHadMultiple && dragDist < MOVE_SLOP;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchStartDist = 0;
    if (pointers.size === 0) {
      dragging = false;
      last = null;
      gestureHadMultiple = false;
    } else if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      dragging = true;
      last = { x: p.x, y: p.y };
    }
    if (selectOnRelease) {
      const selected = boardFromClient(ev.clientX, ev.clientY);
      if (selected) selectTile(selected);
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
    if (ev.key === "Escape" && !tileInspector?.hidden) {
      ev.preventDefault();
      clearSelectedTile();
      if (typeof boardEl.focus === "function") boardEl.focus({ preventScroll: true });
      return;
    }
    if (ev.target instanceof Element && /input|textarea|select/i.test(ev.target.tagName)) return;
    const boardFocused = document.activeElement === boardEl;
    if (boardFocused && !ev.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) {
      const current = selectedTile || { x: Math.floor(size / 2), y: Math.floor(size / 2) };
      const next = { x: current.x, y: current.y };
      if (ev.key === "ArrowLeft") next.x = Math.max(0, current.x - 1);
      else if (ev.key === "ArrowRight") next.x = Math.min(size - 1, current.x + 1);
      else if (ev.key === "ArrowUp") next.y = Math.max(0, current.y - 1);
      else next.y = Math.min(size - 1, current.y + 1);
      ev.preventDefault();
      selectTile(next);
      return;
    }
    if (boardFocused && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      selectTile(selectedTile || { x: Math.floor(size / 2), y: Math.floor(size / 2) });
      return;
    }
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

  tileInspectorClose?.addEventListener("click", clearSelectedTile);
  tileInspectorRetry?.addEventListener("click", () => {
    const selected = selectedTile;
    if (!selected || tileRequest) return;
    showInspectorState(selected, "Loading");
    void fetchSelectedTile(selected);
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
      "4. Preserve coherent art; place up to 20 tiles per atomic batch, up to 20 tiles per IP each minute.",
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
  loadTickerState();
  loadFollowState();
  startPolling();

  window.addEventListener("pagehide", () => {
    stopPolling();
    syncTickerMotion();
    cancelAnimationFrame(rafId);
    clearTimeout(painterTagTimer);
    clearTimeout(particleTimer);
    clearTimeout(toastTimer);
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) startPolling();
    syncTickerMotion();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pausePolling();
    else resumePolling();
    syncTickerMotion();
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
