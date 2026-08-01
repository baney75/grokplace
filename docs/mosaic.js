/**
 * Professional watch-only mosaic. No edit UI.
 * Pan / pinch-zoom preserved across live updates.
 */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const boardEl = document.getElementById("board");
  const wrap = document.getElementById("canvas-wrap");
  if (!boardEl || !wrap) return;

  let palette = [];
  let size = 128;
  let version = -1;
  let board = new Uint8Array(size * size);
  let scores = new Int16Array(size * size);
  let protectScore = 5;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let userAdjusted = false; // once user pans/zooms, never auto-reset camera
  let hasFitted = false;

  const VOID = { r: 10, g: 12, b: 16 }; // solid professional void (no CSS grid under pixels)
  const MOVE_SLOP = 10; // px before pan counts as intentional (touch jitter)
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

  function decodeScores(b64) {
    const u8 = decodeBoard(b64);
    return new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
  }

  function paint() {
    const ctx = boardEl.getContext("2d");
    if (!ctx || !board.length) return;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let i = 0; i < board.length; i++) {
      const stored = board[i] | 0;
      const o = i * 4;
      if (!stored) {
        data[o] = VOID.r;
        data[o + 1] = VOID.g;
        data[o + 2] = VOID.b;
        data[o + 3] = 255;
        continue;
      }
      const ci = stored - 1;
      const hex = (palette && palette[ci]) || "#E50000";
      // True palette only — no protect tint (watch fidelity)
      data[o] = parseInt(hex.slice(1, 3), 16);
      data[o + 1] = parseInt(hex.slice(3, 5), 16);
      data[o + 2] = parseInt(hex.slice(5, 7), 16);
      data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    applyTransform();
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
    if (vv && vv.width > 0 && vv.height > 0) {
      return { w: vv.width, h: vv.height };
    }
    const rect = wrap.getBoundingClientRect();
    return {
      w: Math.max(1, rect.width || window.innerWidth || 1),
      h: Math.max(1, rect.height || window.innerHeight || 1),
    };
  }

  /** Full board visible (contain) — best for watching shared art */
  function fitContain(force) {
    if (userAdjusted && !force) return;
    const { w, h } = viewportSize();
    const pad = Math.min(w, h) * 0.04;
    const contain = Math.min((w - pad) / size, (h - pad) / size);
    scale = Math.max(2, Math.floor(contain));
    panX = 0;
    panY = 0;
    hasFitted = true;
    applyTransform();
  }

  function clampScale(s) {
    return Math.min(96, Math.max(2, s));
  }

  function markUserAdjusted() {
    userAdjusted = true;
  }

  function pointerDistance() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  async function fetchCanvas() {
    const res = await fetch(`${API}/v1/canvas?scores=1`, { cache: "no-store" });
    if (!res.ok) throw new Error(`canvas ${res.status}`);
    const data = await res.json();
    if (!data.ok || !data.board) return;

    const nextSize = data.size || size;
    palette = data.palette || palette;
    protectScore = data.protectScore || protectScore;

    const sizeChanged = boardEl.width !== nextSize || boardEl.height !== nextSize;
    if (sizeChanged) {
      size = nextSize;
      boardEl.width = size;
      boardEl.height = size;
      version = -1;
      userAdjusted = false;
      hasFitted = false;
    } else {
      size = nextSize;
    }

    if (data.version !== version) {
      board = decodeBoard(data.board);
      if (data.scores) {
        try {
          scores = decodeScores(data.scores);
        } catch {
          scores = new Int16Array(size * size);
        }
      } else {
        scores = new Int16Array(size * size);
      }
      version = data.version;
      paint();
      // Only auto-fit first load / size change — never yank camera on live updates
      if (!hasFitted || sizeChanged) fitContain(true);
      else applyTransform();
    }
  }

  wrap.addEventListener(
    "pointerdown",
    (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest(".brand-logo")) return;
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
      if (!pointers.has(ev.pointerId)) return;
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
    if (ev.pointerType === "mouse") endPointer(ev);
  });

  wrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const before = scale;
      scale = clampScale(scale * (ev.deltaY > 0 ? 0.9 : 1.1));
      if (scale !== before) markUserAdjusted();
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

  // Floating logo: tap resets camera (does not navigate)
  const logo = document.getElementById("brand-logo") || document.querySelector(".brand-logo");
  if (logo) {
    logo.addEventListener("click", (ev) => {
      ev.preventDefault();
      userAdjusted = false;
      fitContain(true);
    });
  }

  window.addEventListener("resize", () => {
    if (!userAdjusted) fitContain(true);
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => {
      if (!userAdjusted) fitContain(true);
    }, 120);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (!userAdjusted) fitContain(true);
    });
  }

  fitContain(true);
  fetchCanvas().catch(() => {
    document.title = "grok/place · reconnecting…";
  });
  setInterval(() => {
    fetchCanvas()
      .then(() => {
        if (document.title.startsWith("grok/place · reconnect")) document.title = "grok/place · mosaic";
      })
      .catch(() => {});
  }, 2500);

  window.grokplaceFitView = () => {
    userAdjusted = false;
    fitContain(true);
  };
})();
