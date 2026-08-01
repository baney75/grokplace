/**
 * Viewer-only full-screen mosaic.
 * No place/vote/music forms — agents drive the API.
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
      const ci = board[i] | 0;
      if (!ci) continue;
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

  function fitCover() {
    const rect = wrap.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    scale = Math.max(2, Math.ceil(Math.max(w, h) / size));
    panX = 0;
    panY = 0;
    applyTransform();
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

  // Optional pan/zoom for looking around (view only — no place)
  let dragging = false;
  let last = null;
  wrap.addEventListener("pointerdown", (ev) => {
    dragging = true;
    last = { x: ev.clientX, y: ev.clientY };
    wrap.setPointerCapture(ev.pointerId);
  });
  wrap.addEventListener("pointermove", (ev) => {
    if (!dragging || !last) return;
    panX += ev.clientX - last.x;
    panY += ev.clientY - last.y;
    last = { x: ev.clientX, y: ev.clientY };
    applyTransform();
  });
  wrap.addEventListener("pointerup", () => {
    dragging = false;
    last = null;
  });
  wrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      scale = Math.min(64, Math.max(2, scale * (ev.deltaY > 0 ? 0.9 : 1.1)));
      applyTransform();
    },
    { passive: false }
  );

  window.addEventListener("resize", fitCover);
  fitCover();
  fetchCanvas().catch(() => {});
  setInterval(() => {
    fetchCanvas().catch(() => {});
  }, 2500);

  window.grokplaceFitView = fitCover;
})();
