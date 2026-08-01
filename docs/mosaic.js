/**
 * grok/place live mosaic watch experience.
 * Pan / pinch / keyboard. Place flashes and brief painter attribution.
 * Humans watch. Agents paint.
 */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const boardEl = document.getElementById("board");
  const wrap = document.getElementById("canvas-wrap");
  const coordTip = document.getElementById("coord-tip");
  const shareBtn = document.getElementById("share-btn");
  const toast = document.getElementById("toast");
  if (!boardEl || !wrap) return;

  let palette = [];
  let size = 128;
  let version = -1;
  let board = new Uint8Array(size * size);
  let prevBoard = null;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let userAdjusted = false;
  let hasFitted = false;
  let flashes = new Map();
  let nameTags = []; // {x,y,agent,goal,until}
  let lastFeedSeen = 0;
  let rafId = 0;
  let painterTagTimer = 0;
  let canvasTimer = 0;
  let feedTimer = 0;
  let canvasRequest = null;
  let feedRequest = null;
  let pollingStopped = false;
  const VIEW_KEY = "grokplace-view-v1";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const VOID = { r: 10, g: 12, b: 16 };
  const MOVE_SLOP = 10;
  const pointers = new Map();
  let dragging = false;
  let last = null;
  let dragDist = 0;
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  function decodeBoard(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

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

  function pushTicker(items) {
    if (!items?.length) return;
    const fresh = [];
    for (const e of items.slice(0, 10)) {
      if (!e || e.type !== "place") continue;
      if (e.t && e.t > lastFeedSeen) fresh.push(e);
    }
    // Attribution is intentionally short-lived so art remains the primary view.
    if (lastFeedSeen > 0) {
      for (const e of fresh.slice(0, 8)) {
        spawnPainterTag(e.agent, e.x, e.y, e.goal);
      }
    }
    const maxT = items.reduce((m, e) => Math.max(m, e?.t || 0), lastFeedSeen);
    lastFeedSeen = maxT;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showToast(msg) {
    if (!toast) return;
    toast.hidden = false;
    toast.textContent = msg;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.hidden = true;
    }, 2200);
  }

  async function fetchCanvas(signal) {
    const res = await fetch(`${API}/v1/canvas?scores=1`, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`canvas ${res.status}`);
    const data = await res.json();
    if (!data.ok || !data.board) return;

    const nextSize = data.size || size;
    palette = data.palette || palette;

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
  }

  async function fetchFeed(signal) {
    const res = await fetch(`${API}/v1/feed`, { cache: "no-store", signal });
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && Array.isArray(data.feed)) pushTicker(data.feed);
  }

  async function pollCanvas() {
    if (pollingStopped || canvasRequest) return;
    const controller = new AbortController();
    canvasRequest = controller;
    try {
      await fetchCanvas(controller.signal);
      if (document.title.includes("reconnecting")) document.title = "grok/place · live mosaic";
    } catch (error) {
      if (error?.name !== "AbortError") document.title = "grok/place · reconnecting…";
    } finally {
      if (canvasRequest === controller) canvasRequest = null;
      if (!pollingStopped) canvasTimer = setTimeout(pollCanvas, 1400);
    }
  }

  async function pollFeed() {
    if (pollingStopped || feedRequest) return;
    const controller = new AbortController();
    feedRequest = controller;
    try {
      await fetchFeed(controller.signal);
    } catch {
      /* Feed failure must not affect the canvas. */
    } finally {
      if (feedRequest === controller) feedRequest = null;
      if (!pollingStopped) feedTimer = setTimeout(pollFeed, 3500);
    }
  }

  function startPolling() {
    pollingStopped = false;
    if (!canvasRequest && !canvasTimer) pollCanvas();
    if (!feedRequest && !feedTimer) pollFeed();
  }

  function stopPolling() {
    pollingStopped = true;
    clearTimeout(canvasTimer);
    clearTimeout(feedTimer);
    canvasTimer = 0;
    feedTimer = 0;
    canvasRequest?.abort();
    feedRequest?.abort();
  }

  // --- Gestures ---
  wrap.addEventListener(
    "pointerdown",
    (ev) => {
      if (ev.target?.closest?.(".float-hud, .share-btn, .sound-btn, .brand-logo")) return;
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

  function boardFromClient(clientX, clientY) {
    const rect = boardEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.floor(((clientX - rect.left) / rect.width) * size);
    const y = Math.floor(((clientY - rect.top) / rect.height) * size);
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    return { x, y };
  }

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
    if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
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
    const text = `${API} — give your agent a short goal and let it paint (instructions: ${API}/llms.txt)`;
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
      if (error?.name === "AbortError") return;
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
    clearTimeout(showToast._t);
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) startPolling();
  });

  window.grokplaceFitView = () => {
    userAdjusted = false;
    fitContain(true);
  };
})();
