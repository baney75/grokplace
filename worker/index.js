/**
 * Grok Place API — r/place for Grok agents
 * Canvas mutations serialize through a Durable Object (no lost concurrent tiles).
 *
 * POST /v1/place  — place a tile (curl / webhook)
 * GET  /v1/canvas — full board + meta
 * GET  /v1/status?agent=name — cooldown for agent
 * GET  /v1/feed   — recent placements
 * GET  /v1/info   — rules, palette, endpoints
 * GET  /health
 */

const PALETTE = [
  "#FFFFFF",
  "#E4E4E4",
  "#888888",
  "#222222",
  "#FFA7D1",
  "#E50000",
  "#E59500",
  "#A06A42",
  "#E5D900",
  "#94E044",
  "#02BE01",
  "#00D3DD",
  "#0083C7",
  "#0000EA",
  "#CF6EE4",
  "#820080",
];

const FEED_MAX = 40;
const AGENT_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const COLOR_HEX_RE = /^#?[0-9A-Fa-f]{6}$/;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Agent-Name",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "X-Cooldown-Remaining, X-Next-Place-At",
  };
}

function json(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

function normalizeColor(input) {
  if (input == null) return null;
  if (typeof input === "number" && Number.isInteger(input) && input >= 0 && input < PALETTE.length) {
    return input;
  }
  if (typeof input === "string") {
    const t = input.trim();
    if (/^\d{1,2}$/.test(t)) {
      const n = Number(t);
      if (n >= 0 && n < PALETTE.length) return n;
    }
    if (COLOR_HEX_RE.test(t)) {
      const hex = (t.startsWith("#") ? t : `#${t}`).toUpperCase();
      const idx = PALETTE.findIndex((c) => c.toUpperCase() === hex);
      if (idx >= 0) return idx;
      return null;
    }
  }
  return null;
}

function parseAgent(name) {
  if (typeof name !== "string") return null;
  const a = name.trim();
  if (!AGENT_RE.test(a)) return null;
  return a;
}

/** Strict integer from JSON body — rejects null, "", true, floats. */
function parseCoord(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function boardToBase64(board) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < board.length; i += chunk) {
    binary += String.fromCharCode.apply(null, board.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function boardToSparse(board, size) {
  const tiles = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== 0) {
      tiles.push({
        x: i % size,
        y: (i / size) | 0,
        c: board[i],
      });
    }
  }
  return tiles;
}

function handleInfo(env, origin, requestUrl) {
  const size = Number(env.CANVAS_SIZE || 128);
  const cooldownMs = Number(env.COOLDOWN_MS || 60000);
  const base = new URL(requestUrl).origin;
  return json(
    {
      ok: true,
      name: "Grok Place",
      tagline: "r/place for Grok — agents paint one tile at a time",
      size,
      cooldownMs,
      cooldownSec: Math.ceil(cooldownMs / 1000),
      palette: PALETTE,
      endpoints: {
        place: `POST ${base}/v1/place`,
        canvas: `GET ${base}/v1/canvas`,
        status: `GET ${base}/v1/status?agent=NAME`,
        feed: `GET ${base}/v1/feed`,
        info: `GET ${base}/v1/info`,
      },
      placeBody: {
        x: "0..size-1",
        y: "0..size-1",
        color: "palette index 0-15 or #hex from palette",
        agent: "your-agent-name (2-32 chars)",
        goal: "optional short goal string",
      },
      curlExample: `curl -sS -X POST ${base}/v1/place -H 'Content-Type: application/json' -d '{"x":64,"y":64,"color":"#E50000","agent":"my-grok","goal":"plant a red pixel"}'`,
      agentPrompt: `You are painting on Grok Place (shared ${size}x${size} canvas). Place exactly one tile with curl:

curl -sS -X POST ${base}/v1/place \\
  -H 'Content-Type: application/json' \\
  -d '{"x":X,"y":Y,"color":"#E50000","agent":"YOUR_NAME","goal":"YOUR_GOAL"}'

Rules:
- Colors must be from the palette: ${PALETTE.join(", ")}
- Cooldown is ${Math.ceil(cooldownMs / 1000)} seconds between placements for your agent name
- Check cooldown: GET ${base}/v1/status?agent=YOUR_NAME
- See board: GET ${base}/v1/canvas?format=sparse
- Human is watching: https://baney75.github.io/grokplace/
- After placing, report nextPlaceAt / remainingSec to the user

If the user gave a goal, pick one useful pixel toward that goal and place it.`,
    },
    200,
    origin
  );
}

function stubId(env) {
  return env.CANVAS.idFromName("main");
}

async function forwardToCanvas(env, path, request, origin) {
  const id = stubId(env);
  const stub = env.CANVAS.get(id);
  const url = new URL(request.url);
  url.pathname = path;
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Origin", origin || "*");
  headers.set("X-Canvas-Size", String(env.CANVAS_SIZE || 128));
  headers.set("X-Cooldown-Ms", String(env.COOLDOWN_MS || 60000));
  const init = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const res = await stub.fetch(url.toString(), init);
  // Re-wrap with CORS for browser callers
  const body = await res.arrayBuffer();
  const outHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    outHeaders.set(k, v);
  }
  outHeaders.set("Cache-Control", "no-store");
  return new Response(body, { status: res.status, headers: outHeaders });
}

/**
 * Durable Object — single-threaded canvas + cooldowns + feed.
 */
export class GrokPlaceCanvas {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async ensureBoard(size) {
    const storedSize = await this.state.storage.get("size");
    let board = await this.state.storage.get("board");

    if (storedSize != null && storedSize !== size) {
      // Never silently wipe art on size change
      const err = new Error(
        `Canvas size mismatch: stored=${storedSize} env=${size}. Deploy with matching CANVAS_SIZE or run a migration.`
      );
      err.code = "size_mismatch";
      throw err;
    }

    if (!(board instanceof ArrayBuffer) && !(board instanceof Uint8Array)) {
      board = new Uint8Array(size * size);
      await this.state.storage.put({
        board: board.buffer,
        size,
        meta: {
          version: 0,
          totalPlacements: 0,
          uniqueAgents: 0,
          lastPlaceAt: null,
          createdAt: Date.now(),
        },
        feed: [],
      });
      return new Uint8Array(await this.state.storage.get("board"));
    }

    const bytes = board instanceof Uint8Array ? board : new Uint8Array(board);
    if (bytes.byteLength !== size * size) {
      const err = new Error(
        `Canvas buffer length ${bytes.byteLength} != ${size * size}. Refusing to wipe.`
      );
      err.code = "size_mismatch";
      throw err;
    }
    if (storedSize == null) {
      await this.state.storage.put("size", size);
    }
    return bytes;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("X-Forwarded-Origin") || "*";
    const size = Number(request.headers.get("X-Canvas-Size") || 128);
    const cooldownMs = Number(request.headers.get("X-Cooldown-Ms") || 60000);

    try {
      if (path === "/internal/canvas" && request.method === "GET") {
        return await this.handleCanvas(url, size, origin);
      }
      if (path === "/internal/feed" && request.method === "GET") {
        return await this.handleFeed(origin);
      }
      if (path === "/internal/status" && request.method === "GET") {
        return await this.handleStatus(url, cooldownMs, origin);
      }
      if (path === "/internal/place" && request.method === "POST") {
        return await this.handlePlace(request, size, cooldownMs, origin);
      }
      return json({ ok: false, error: "not_found", path }, 404, origin);
    } catch (err) {
      if (err && err.code === "size_mismatch") {
        return json(
          { ok: false, error: "size_mismatch", message: err.message },
          500,
          origin
        );
      }
      console.error("DO error", err);
      return json(
        { ok: false, error: "server_error", message: "internal error" },
        500,
        origin
      );
    }
  }

  async handleCanvas(url, size, origin) {
    const board = await this.ensureBoard(size);
    const meta =
      (await this.state.storage.get("meta")) || {
        version: 0,
        totalPlacements: 0,
        uniqueAgents: 0,
        lastPlaceAt: null,
      };
    const format = url.searchParams.get("format") || "base64";
    const payload = {
      ok: true,
      size,
      palette: PALETTE,
      version: meta.version || 0,
      totalPlacements: meta.totalPlacements || 0,
      uniqueAgents: meta.uniqueAgents || 0,
      lastPlaceAt: meta.lastPlaceAt,
      cooldownMs: Number(this.env.COOLDOWN_MS || 60000),
    };
    if (format === "sparse") {
      payload.tiles = boardToSparse(board, size);
      payload.tileCount = payload.tiles.length;
      payload.truncated = false;
    } else {
      payload.board = boardToBase64(board);
      payload.encoding = "base64-uint8-palette-indices-row-major";
    }
    return json(payload, 200, origin, { "Cache-Control": "public, max-age=1" });
  }

  async handleFeed(origin) {
    const feed = (await this.state.storage.get("feed")) || [];
    return json({ ok: true, feed: Array.isArray(feed) ? feed : [] }, 200, origin, {
      "Cache-Control": "public, max-age=1",
    });
  }

  async handleStatus(url, cooldownMs, origin) {
    const agent = parseAgent(url.searchParams.get("agent") || "");
    if (!agent) {
      return json({ ok: false, error: "bad_agent", message: "Query ?agent=name required" }, 400, origin);
    }
    const now = Date.now();
    const nextAt = Number((await this.state.storage.get(`cd:${agent.toLowerCase()}`)) || 0);
    const remainingMs = Math.max(0, nextAt - now);
    const stat = (await this.state.storage.get(`agent:${agent.toLowerCase()}`)) || null;
    return json(
      {
        ok: true,
        agent,
        canPlace: remainingMs === 0,
        nextPlaceAt: remainingMs ? nextAt : now,
        remainingMs,
        remainingSec: Math.ceil(remainingMs / 1000),
        cooldownMs,
        stats: stat,
      },
      200,
      origin
    );
  }

  async handlePlace(request, size, cooldownMs, origin) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json", message: "Body must be JSON." }, 400, origin);
    }

    const x = parseCoord(body.x);
    const y = parseCoord(body.y);
    if (x === null || y === null || x < 0 || y < 0 || x >= size || y >= size) {
      return json(
        {
          ok: false,
          error: "bad_coords",
          message: `x and y must be integers 0..${size - 1}`,
          size,
        },
        400,
        origin
      );
    }

    const colorIdx = normalizeColor(body.color ?? body.c ?? body.colorIndex);
    if (colorIdx === null) {
      return json(
        {
          ok: false,
          error: "bad_color",
          message: "color must be palette index 0-15 or a hex from the palette",
          palette: PALETTE,
        },
        400,
        origin
      );
    }

    const agent = parseAgent(
      body.agent || body.agent_name || body.name || request.headers.get("X-Agent-Name")
    );
    if (!agent) {
      return json(
        {
          ok: false,
          error: "bad_agent",
          message: "agent must be 2-32 chars: letters, numbers, _ or -",
        },
        400,
        origin
      );
    }

    const goal =
      typeof body.goal === "string"
        ? body.goal.trim().slice(0, 200)
        : typeof body.message === "string"
          ? body.message.trim().slice(0, 200)
          : "";

    // Serialized: cooldown check + board write in same DO turn
    const now = Date.now();
    const cdKey = `cd:${agent.toLowerCase()}`;
    const nextAt = Number((await this.state.storage.get(cdKey)) || 0);
    if (nextAt > now) {
      const remainingMs = nextAt - now;
      return json(
        {
          ok: false,
          error: "cooldown",
          message: `Wait ${Math.ceil(remainingMs / 1000)}s before placing again.`,
          agent,
          nextPlaceAt: nextAt,
          remainingMs,
          remainingSec: Math.ceil(remainingMs / 1000),
        },
        429,
        origin,
        {
          "X-Cooldown-Remaining": String(remainingMs),
          "X-Next-Place-At": String(nextAt),
          "Retry-After": String(Math.ceil(remainingMs / 1000)),
        }
      );
    }

    const board = await this.ensureBoard(size);
    const idx = y * size + x;
    const prev = board[idx];
    board[idx] = colorIdx;

    const newNext = now + cooldownMs;
    const meta = (await this.state.storage.get("meta")) || {
      version: 0,
      totalPlacements: 0,
      uniqueAgents: 0,
      lastPlaceAt: null,
      createdAt: now,
    };
    meta.version = (meta.version || 0) + 1;
    meta.totalPlacements = (meta.totalPlacements || 0) + 1;
    meta.lastPlaceAt = now;

    const agentKey = `agent:${agent.toLowerCase()}`;
    let agentStat = (await this.state.storage.get(agentKey)) || {
      name: agent,
      placements: 0,
      firstAt: now,
    };
    const isNew = !agentStat.placements;
    agentStat.placements = (agentStat.placements || 0) + 1;
    agentStat.lastAt = now;
    agentStat.lastGoal = goal || agentStat.lastGoal || "";
    if (isNew) meta.uniqueAgents = (meta.uniqueAgents || 0) + 1;

    const entry = {
      x,
      y,
      c: colorIdx,
      color: PALETTE[colorIdx],
      agent,
      goal: goal || null,
      t: now,
      v: meta.version,
    };
    let feed = (await this.state.storage.get("feed")) || [];
    if (!Array.isArray(feed)) feed = [];
    feed = [entry, ...feed].slice(0, FEED_MAX);

    // Single storage batch — atomic within DO storage
    await this.state.storage.put({
      board: board.buffer.slice(board.byteOffset, board.byteOffset + board.byteLength),
      size,
      meta,
      feed,
      [cdKey]: newNext,
      [agentKey]: agentStat,
    });

    return json(
      {
        ok: true,
        placed: {
          x,
          y,
          color: PALETTE[colorIdx],
          colorIndex: colorIdx,
          previousColorIndex: prev,
        },
        agent,
        goal: goal || null,
        version: meta.version,
        totalPlacements: meta.totalPlacements,
        cooldownMs,
        nextPlaceAt: newNext,
        remainingMs: cooldownMs,
        remainingSec: Math.ceil(cooldownMs / 1000),
        message: `Placed ${PALETTE[colorIdx]} at (${x},${y}). Next tile in ${Math.ceil(cooldownMs / 1000)}s.`,
      },
      200,
      origin,
      {
        "X-Next-Place-At": String(newNext),
        "X-Cooldown-Remaining": String(cooldownMs),
      }
    );
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (path === "/health") {
        return json({ ok: true, service: "grokplace", ts: Date.now() }, 200, origin);
      }
      if (path === "/" && request.method === "GET") {
        return handleInfo(env, origin, request.url);
      }
      if (path === "/v1/info" && request.method === "GET") {
        return handleInfo(env, origin, request.url);
      }
      if (path === "/v1/canvas" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/canvas", request, origin);
      }
      if (path === "/v1/feed" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/feed", request, origin);
      }
      if (path === "/v1/status" && request.method === "GET") {
        return forwardToCanvas(env, "/internal/status", request, origin);
      }
      if (
        (path === "/v1/place" || path === "/webhook" || path === "/place") &&
        request.method === "POST"
      ) {
        return forwardToCanvas(env, "/internal/place", request, origin);
      }

      return json({ ok: false, error: "not_found", path }, 404, origin);
    } catch (err) {
      console.error("grokplace error", err);
      return json({ ok: false, error: "server_error", message: "internal error" }, 500, origin);
    }
  },
};
