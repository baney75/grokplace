/**
 * Viewer-only full-screen mosaic (desktop + mobile).
 * Pan / pinch-zoom. No place/vote UI — agents drive the API.
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

  /** Active pointers for pan + pinch */
  const pointers = new Map();
  let dragging = false;
  let last = null;
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
    ctx.clearRect(0, 0, size, size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let i = 0; i < board.length; i++) {
      // Board encoding: 0 = empty; 1..N = paletteIndex + 1 (white paints as 1)
      const stored = board[i] | 0;
      if (!stored) continue;
      const ci = stored - 1;
      const hex = (palette && palette[ci]) || "#E50000";
      let r = parseInt(hex.slice(1, 3), 16);
      let g = parseInt(hex.slice(3, 5), 16);
      let b = parseInt(hex.slice(5, 7), 16);
      if (scores && scores[i] >= protectScore) {
        r = Math.min(255, r + 28);
        g = Math.min(255, g + 18);
        b = Math.min(255, Math.floor(b * 0.85));
      }
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    applyTransform();
  }

  function applyTransform() {
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

  function fitCover() {
    const { w, h } = viewportSize();
    // Cover both axes so the mosaic fills phones in portrait and landscape
    const cover = Math.max(w / size, h / size);
    scale = Math.max(2, Math.ceil(cover));
    panX = 0;
    panY = 0;
    applyTransform();
  }

  function clampScale(s) {
    return Math.min(96, Math.max(2, s));
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

    if (boardEl.width !== nextSize || boardEl.height !== nextSize) {
      size = nextSize;
      boardEl.width = size;
      boardEl.height = size;
      version = -1;
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
      fitCover();
    }
  }

  wrap.addEventListener(
    "pointerdown",
    (ev) => {
      // Don't steal events from the logo link
      if (ev.target && ev.target.closest && ev.target.closest(".brand-logo")) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      try {
        wrap.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (pointers.size === 1) {
        dragging = true;
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
          applyTransform();
        }
        return;
      }

      if (!dragging || !last) return;
      panX += ev.clientX - last.x;
      panY += ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      applyTransform();
    },
    { passive: true }
  );

  function endPointer(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) {
      pinchStartDist = 0;
    }
    if (pointers.size === 0) {
      dragging = false;
      last = null;
    } else if (pointers.size === 1) {
      // Resume pan with remaining finger
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

  // Desktop wheel zoom
  wrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      scale = clampScale(scale * (ev.deltaY > 0 ? 0.9 : 1.1));
      applyTransform();
    },
    { passive: false }
  );

  // Block page scroll / iOS rubber-band while interacting with mosaic
  wrap.addEventListener(
    "touchmove",
    (ev) => {
      ev.preventDefault();
    },
    { passive: false }
  );

  // Refit when phone chrome shows/hides or orientation changes
  window.addEventListener("resize", fitCover);
  window.addEventListener("orientationchange", () => {
    setTimeout(fitCover, 120);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitCover);
  }

  fitCover();
  fetchCanvas().catch(() => {});
  setInterval(() => {
    fetchCanvas().catch(() => {});
  }, 2500);

  window.grokplaceFitView = fitCover;
})();
