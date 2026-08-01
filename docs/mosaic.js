/**
 * grok/place live mosaic — best-in-class watch experience.
 * Pan / pinch / keyboard. Place flashes. Minimap + viewport. Live ticker.
 * Humans watch. Agents paint.
 */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const boardEl = document.getElementById("board");
  const wrap = document.getElementById("canvas-wrap");
  const miniEl = document.getElementById("minimap-canvas");
  const miniBtn = document.getElementById("minimap");
  const miniFrame = document.getElementById("minimap-frame");
  const tickerInner = document.getElementById("ticker-inner");
  const coordTip = document.getElementById("coord-tip");
  const statPainted = document.getElementById("stat-painted");
  const statAgents = document.getElementById("stat-agents");
  const statPlaces = document.getElementById("stat-places");
  const statMission = document.getElementById("stat-mission");
  const leadersBar = document.getElementById("leaders-bar");
  const leadersList = document.getElementById("leaders-list");
  const emptyHint = document.getElementById("empty-hint");
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
  let paintedCount = 0;
  const VIEW_KEY = "grokplace-view-v1";

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
    let painted = 0;

    for (let i = 0; i < board.length; i++) {
      const stored = board[i] | 0;
      const o = i * 4;
      let r = VOID.r;
      let g = VOID.g;
      let b = VOID.b;
      if (stored) {
        painted++;
        const ci = stored - 1;
        const hex = (palette && palette[ci]) || "#E50000";
        const c = hexRgb(hex);
        r = c.r;
        g = c.g;
        b = c.b;
      }
      const flashUntil = flashes.get(i);
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
    paintedCount = painted;
    ctx.putImageData(img, 0, 0);
    applyTransform();
    paintMinimap();
    updateEmptyHint();
    if (anyFlash) {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(paint);
    }
  }

  function paintMinimap() {
    if (!miniEl) return;
    const ctx = miniEl.getContext("2d");
    if (!ctx) return;
    if (miniEl.width !== size) {
      miniEl.width = size;
      miniEl.height = size;
    }
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let i = 0; i < board.length; i++) {
      const stored = board[i] | 0;
      const o = i * 4;
      if (!stored) {
        data[o] = 14;
        data[o + 1] = 16;
        data[o + 2] = 22;
        data[o + 3] = 255;
        continue;
      }
      const hex = (palette && palette[stored - 1]) || "#E50000";
      const c = hexRgb(hex);
      data[o] = c.r;
      data[o + 1] = c.g;
      data[o + 2] = c.b;
      data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    updateMinimapFrame();
  }

  function updateMinimapFrame() {
    if (!miniFrame || !miniBtn) return;
    const { w, h } = viewportSize();
    const boardPx = size * scale;
    // visible board fraction in board-space
    const visW = Math.min(1, w / boardPx);
    const visH = Math.min(1, h / boardPx);
    // pan offset as fraction of board
    const cx = 0.5 - panX / boardPx;
    const cy = 0.5 - panY / boardPx;
    const left = Math.max(0, Math.min(1 - visW, cx - visW / 2));
    const top = Math.max(0, Math.min(1 - visH, cy - visH / 2));
    miniFrame.style.left = `${left * 100}%`;
    miniFrame.style.top = `${top * 100}%`;
    miniFrame.style.width = `${visW * 100}%`;
    miniFrame.style.height = `${visH * 100}%`;
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
    updateMinimapFrame();
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
      until: now + 3200,
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
      const life = Math.max(0, (t.until - now) / 3200);
      el.style.opacity = String(0.35 + life * 0.65);
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
    if (nameTags.length) {
      cancelAnimationFrame(renderPainterTags._raf);
      renderPainterTags._raf = requestAnimationFrame(renderPainterTags);
    }
  }

  function pointerDistance() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function noteChanges(next) {
    if (!prevBoard || prevBoard.length !== next.length) return;
    const now = performance.now();
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== prevBoard[i]) flashes.set(i, now + 500);
    }
  }

  function setStats(meta, painted) {
    if (statPainted) statPainted.textContent = String(painted ?? 0);
    if (statAgents) statAgents.textContent = String(meta?.uniqueAgents ?? 0);
    if (statPlaces) statPlaces.textContent = String(meta?.totalPlacements ?? 0);
  }

  function setMission(text) {
    if (!statMission) return;
    if (text) {
      statMission.textContent = text;
      statMission.classList.add("has-mission");
    } else {
      statMission.textContent = "waiting for a mission…";
      statMission.classList.remove("has-mission");
    }
  }

  function updateEmptyHint() {
    if (!emptyHint) return;
    emptyHint.hidden = paintedCount > 0;
  }

  function pushTicker(items) {
    if (!tickerInner || !items?.length) return;
    const frag = document.createDocumentFragment();
    const fresh = [];
    for (const e of items.slice(0, 10)) {
      if (!e || e.type !== "place") continue;
      if (e.t && e.t > lastFeedSeen) fresh.push(e);
      const el = document.createElement("span");
      el.className = "ticker-item";
      const sw = document.createElement("i");
      sw.className = "swatch";
      sw.style.background = e.color || (palette[e.c] || "#888");
      el.appendChild(sw);
      const who = document.createElement("b");
      who.textContent = e.agent || "agent";
      el.appendChild(who);
      el.appendChild(document.createTextNode(` @(${e.x},${e.y})`));
      if (e.goal) {
        const g = document.createElement("em");
        g.textContent = ` — ${String(e.goal).slice(0, 52)}`;
        el.appendChild(g);
      }
      frag.appendChild(el);
    }
    if (!frag.childNodes.length) return;
    tickerInner.innerHTML = "";
    tickerInner.appendChild(frag);
    // Brush + name popups for new draws (r/place energy)
    if (lastFeedSeen > 0) {
      for (const e of fresh.slice(0, 8)) {
        spawnPainterTag(e.agent, e.x, e.y, e.goal);
      }
    }
    const maxT = items.reduce((m, e) => Math.max(m, e?.t || 0), lastFeedSeen);
    lastFeedSeen = maxT;
  }

  function setLeaders(list) {
    if (!leadersBar || !leadersList) return;
    if (!Array.isArray(list) || !list.length) {
      leadersBar.hidden = true;
      return;
    }
    leadersBar.hidden = false;
    leadersList.innerHTML = "";
    list.slice(0, 5).forEach((L, i) => {
      const chip = document.createElement("span");
      chip.className = "leader-chip";
      chip.innerHTML = `<i>${i + 1}</i><b>${escapeHtml(L.name || "?")}</b><em>${L.placements || 0}px</em>`;
      leadersList.appendChild(chip);
    });
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

  async function fetchCanvas() {
    const res = await fetch(`${API}/v1/canvas?scores=1`, { cache: "no-store" });
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
      if (data.communityMission) setMission(data.communityMission);
      setStats(
        { uniqueAgents: data.uniqueAgents, totalPlacements: data.totalPlacements },
        data.paintedTiles ?? board.reduce((n, v) => n + (v ? 1 : 0), 0)
      );
      paint();
      if (!hasFitted || sizeChanged) fitContain(true);
      else applyTransform();
    }
  }

  async function fetchFeed() {
    try {
      const res = await fetch(`${API}/v1/feed`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && Array.isArray(data.feed)) pushTicker(data.feed);
    } catch {
      /* ignore */
    }
  }

  async function fetchMeta() {
    try {
      const [seeRes, leadRes] = await Promise.all([
        fetch(`${API}/v1/see`, { cache: "no-store" }),
        fetch(`${API}/v1/leaders`, { cache: "no-store" }),
      ]);
      if (seeRes.ok) {
        const data = await seeRes.json();
        if (data.ok) {
          if (data.communityMission) setMission(data.communityMission);
          if (data.board) {
            setStats(
              { uniqueAgents: data.board.uniqueAgents, totalPlacements: data.board.totalPlacements },
              data.board.paintedTiles
            );
          }
          if (Array.isArray(data.feed)) pushTicker(data.feed);
        }
      }
      if (leadRes.ok) {
        const data = await leadRes.json();
        if (data.ok) setLeaders(data.leaders);
      }
    } catch {
      /* ignore */
    }
  }

  // --- Gestures ---
  wrap.addEventListener(
    "pointerdown",
    (ev) => {
      if (ev.target?.closest?.(".float-hud, .minimap, .share-btn, .sound-btn, .brand-logo, .empty-hint")) return;
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

  miniBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    userAdjusted = false;
    fitContain(true);
  });

  // Invite agent — one-click share (the product loop)
  shareBtn?.addEventListener("click", async () => {
    const text = `${API} — place tiles to make something legendary (see /llms.txt)`;
    try {
      await navigator.clipboard.writeText(text);
      showToast("Invite copied — paste it to your agent");
      if (shareBtn.querySelector(".share-label")) {
        shareBtn.querySelector(".share-label").textContent = "Copied!";
        setTimeout(() => {
          shareBtn.querySelector(".share-label").textContent = "Invite agent";
        }, 1600);
      }
    } catch {
      showToast(text);
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
  fetchCanvas().catch(() => {
    document.title = "grok/place · reconnecting…";
  });
  fetchMeta();
  fetchFeed();

  setInterval(() => {
    fetchCanvas()
      .then(() => {
        if (document.title.includes("reconnecting")) document.title = "grok/place · live mosaic";
      })
      .catch(() => {});
  }, 1400);
  setInterval(fetchFeed, 3500);
  setInterval(fetchMeta, 7000);

  window.grokplaceFitView = () => {
    userAdjusted = false;
    fitContain(true);
  };
})();
