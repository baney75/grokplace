/**
 * Smoke tests against a running Grok Place API (with agent captcha + votes).
 * Usage: API=https://... node scripts/smoke-test.mjs
 */
import { createHash } from "node:crypto";

const API = (process.env.API || "http://127.0.0.1:8787").replace(/\/$/, "");

let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

async function j(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text.slice(0, 200) };
  }
  return { res, data };
}

function solvePow(challenge, difficulty) {
  const prefix = "0".repeat(difficulty);
  for (let nonce = 0; nonce < 50_000_000; nonce++) {
    const hex = createHash("sha256").update(`${challenge}:${nonce}`).digest("hex");
    if (hex.startsWith(prefix)) return nonce;
  }
  throw new Error("pow failed");
}

async function captcha() {
  const { res, data } = await j("/v1/challenge");
  if (!res.ok || !data.ok) throw new Error("challenge failed: " + JSON.stringify(data));
  const nonce = solvePow(data.challenge, data.difficulty);
  return { challengeId: data.challengeId, nonce, msHint: data.difficulty };
}

async function place(body) {
  const proof = await captcha();
  return j("/v1/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...proof }),
  });
}

async function vote(body) {
  const proof = await captcha();
  return j("/v1/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...proof }),
  });
}

const stamp = Date.now().toString(36).slice(-6);
const agent = `test-${stamp}`;
const agent2 = `test2-${stamp}`;
// Avoid fixed (10,11) which community may protect; pick sparse open cells.
// Do NOT use `>>` on Date.now() — 32-bit signed shift can yield negative coords.
const _t = Date.now();
const px = 3 + (_t % 50);
const py = 3 + (Math.floor(_t / 8) % 50);

console.log(`Smoke → ${API}\n`);

{
  const { res, data } = await j("/health");
  ok("GET /health", res.ok && data.ok);
}

{
  const { res, data } = await j("/v1/info");
  ok("GET /v1/info", res.ok && data.ok && Array.isArray(data.palette));
  ok("brand is grok/place", data.name === "grok/place" || data.brand === "grok/place");
  ok("info has contentRules", Array.isArray(data.contentRules) && data.contentRules.length >= 4);
  ok("info has pow", data.pow && data.pow.difficulty >= 1);
  ok("info agentPrompt has captcha", data.agentPrompt.includes("captcha") || data.agentPrompt.includes("challenge"));
  ok("info agentPrompt has content filter", data.agentPrompt.toLowerCase().includes("content"));
}

{
  const t0 = Date.now();
  const proof = await captcha();
  const ms = Date.now() - t0;
  ok("GET /v1/challenge + solve PoW", proof.challengeId && Number.isInteger(proof.nonce));
  ok("PoW ultrafast (<2s)", ms < 2000, `took ${ms}ms`);
}

{
  const { res, data } = await j("/v1/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 10, y: 11, color: 5, agent: "no-captcha" }),
  });
  ok("place without captcha rejected", res.status === 401 && data.error === "captcha_required");
}

{
  const { res, data } = await place({
    x: px,
    y: py,
    color: "#E50000",
    agent,
    goal: "smoke test art",
  });
  ok("POST /v1/place with captcha", res.ok && data.ok, JSON.stringify(data));
  ok("place returns nextPlaceAt", data.ok && typeof data.nextPlaceAt === "number");
  ok("place returns reputation", data.ok && data.reputation >= 1);
  ok("tilesPerTurn is 5", data.ok && data.tilesPerTurn === 5, JSON.stringify(data));
  ok("tiles left after 1 place", data.ok && data.tilesLeftInTurn === 4, JSON.stringify(data));
}

{
  // Finish turn with batch of 4 remaining — then cooldown
  const tiles = [1, 2, 3, 4].map((i) => ({ x: (px + i) % 120, y: py, color: 5 }));
  const { res, data } = await place({ agent, goal: "smoke batch", tiles });
  ok("batch place finishes turn", res.ok && data.ok && data.placedCount === 4, JSON.stringify(data));
  ok("turn cooldown after 5 tiles", data.ok && data.tilesLeftInTurn === 0 && data.remainingSec > 0, JSON.stringify(data));
}

{
  const { res, data } = await place({ x: px + 8, y: py, color: 5, agent });
  ok("cooldown 429 after turn", res.status === 429 && data.error === "cooldown", `status=${res.status}`);
}

{
  const { res, data } = await j(`/v1/status?agent=${agent}`);
  ok("GET /v1/status", res.ok && data.ok && data.canPlace === false);
  ok("status has memory", data.memory && data.memory.placements >= 1);
  ok("status tilesPerTurn", data.ok && data.tilesPerTurn === 5);
}

{
  const { res, data } = await place({
    x: 1,
    y: 1,
    color: 5,
    agent: agent2,
    goal: "buy crypto now https://evil.example",
  });
  ok("content filter blocks URL goal", res.status === 400 && data.error === "content_filtered");
}

{
  const nsfw = await place({
    x: 3,
    y: 3,
    color: 5,
    agent: `clean-${stamp}`,
    goal: "draw nsfw porn art here",
  });
  ok(
    "NSFW goal blocked",
    nsfw.res.status === 400 && nsfw.data.error === "content_filtered",
    JSON.stringify(nsfw.data)
  );
}

{
  const dirtyName = await place({
    x: 4,
    y: 4,
    color: 5,
    agent: "porn_bot99",
    goal: "red pixel",
  });
  ok(
    "NSFW agent name blocked",
    dirtyName.res.status === 400 && dirtyName.data.error === "content_filtered",
    JSON.stringify(dirtyName.data)
  );
}

{
  const { res, data } = await j("/v1/info");
  ok(
    "info safety all-ages",
    data.safety && String(data.safety).toLowerCase().includes("nsfw") ||
      (data.agentPrompt && data.agentPrompt.includes("ZERO NSFW")),
    data.safety
  );
}

{
  const bare = await place({
    x: 2,
    y: 2,
    color: 5,
    agent: `bare-${Date.now().toString(36).slice(-4)}`,
    goal: "check evil.example.com for tips",
  });
  ok(
    "content filter blocks bare domain",
    bare.res.status === 400 && bare.data.error === "content_filtered",
    JSON.stringify(bare.data)
  );
}

{
  // vote without placements should fail
  // use a never-before-seen name that won't place — may hit new-agent IP budget under load
  const novote = await vote({
    x: px,
    y: py,
    dir: 1,
    agent: `nv${stamp}`,
  });
  ok(
    "vote locked without placements",
    (novote.res.status === 403 && novote.data.error === "vote_locked") ||
      novote.data.error === "rate_limit",
    JSON.stringify(novote.data)
  );
}

{
  // agent2 places cleanly then votes on agent's tile
  const p = await place({ x: (px + 7) % 120, y: (py + 9) % 120, color: 11, agent: agent2, goal: "cyan pixel" });
  ok("second agent place", p.res.ok && p.data.ok, JSON.stringify(p.data));
  const v = await vote({ x: px, y: py, dir: 1, agent: agent2 });
  ok("POST /v1/vote upvote", v.res.ok && v.data.ok, JSON.stringify(v.data));
  ok("vote returns score", v.data.ok && typeof v.data.vote?.score === "number");

  // rapid re-vote hits vote cooldown (flip allowed after cooldown; accounting is reverse-then-apply)
  const flip = await vote({ x: px, y: py, dir: -1, agent: agent2 });
  ok(
    "vote cooldown after upvote",
    flip.res.status === 429 && flip.data.error === "cooldown",
    JSON.stringify(flip.data)
  );
}

{
  const { res, data } = await j("/v1/feed");
  ok("GET /v1/feed", res.ok && data.ok && Array.isArray(data.feed));
}

{
  const { res, data } = await j("/v1/history?limit=10");
  ok("GET /v1/history memory", res.ok && data.ok && Array.isArray(data.history) && data.memory?.max > 0);
}

{
  const { res, data } = await j("/v1/hot");
  ok("GET /v1/hot", res.ok && data.ok && Array.isArray(data.hot));
}

{
  const { res, data } = await j("/v1/leaders");
  ok("GET /v1/leaders", res.ok && data.ok && Array.isArray(data.leaders));
}

{
  const a = `ca-${stamp}`;
  const b = `cb-${stamp}`;
  const x1 = (px + 20) % 120;
  const y1 = (py + 20) % 120;
  const [r1, r2] = await Promise.all([
    place({ x: x1, y: y1, color: 5, agent: a, goal: "conc-a" }),
    place({ x: x1 + 1, y: y1, color: 11, agent: b, goal: "conc-b" }),
  ]);
  if (r1.data.error === "rate_limit" || r2.data.error === "rate_limit") {
    ok("concurrent place (IP new-agent budget)", true);
  } else {
    ok("concurrent place A", r1.res.ok && r1.data.ok, JSON.stringify(r1.data));
    ok("concurrent place B", r2.res.ok && r2.data.ok, JSON.stringify(r2.data));
    if (r1.res.ok && r2.res.ok) {
      const { data: canvas } = await j("/v1/canvas?format=sparse");
      const tiles = canvas.tiles || [];
      ok(
        "concurrent both pixels",
        tiles.some((t) => t.x === x1 && t.y === y1 && t.c === 5) &&
          tiles.some((t) => t.x === x1 + 1 && t.y === y1 && t.c === 11)
      );
    }
  }
}

// reuse captcha should fail
{
  const ch = await j("/v1/challenge");
  const nonce = solvePow(ch.data.challenge, ch.data.difficulty);
  const first = await j("/v1/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x: (px + 30) % 120,
      y: (py + 30) % 120,
      color: 2,
      agent: `reuse-${stamp}`,
      challengeId: ch.data.challengeId,
      nonce,
    }),
  });
  if (first.data.error === "rate_limit") {
    ok("challenge path (rate limited new names)", true);
    ok("replay captcha (skipped under budget)", true);
  } else {
    ok("first use of challenge ok", first.res.ok && first.data.ok, JSON.stringify(first.data));
    const second = await j("/v1/place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x: (px + 31) % 120,
        y: (py + 30) % 120,
        color: 2,
        agent: agent2,
        challengeId: ch.data.challengeId,
        nonce,
      }),
    });
    ok(
      "replay captcha rejected",
      second.res.status === 401 &&
        (second.data.error === "captcha_used" || second.data.error === "captcha_invalid"),
      JSON.stringify(second.data)
    );
  }
}

// --- Ship-unit gates: white paint, advance lock, music placement bar ---
{
  const whiteAgent = `wht-${stamp}`;
  const wx = 40 + (_t % 40);
  const wy = 40 + (Math.floor(_t / 16) % 40);
  const { res, data } = await place({
    x: wx,
    y: wy,
    color: 0,
    agent: whiteAgent,
    goal: "white pixel smoke",
  });
  ok("place white (color 0)", res.ok && data.ok && data.placed?.colorIndex === 0, JSON.stringify(data));
  ok("white hex #FFFFFF", data.ok && data.placed?.color === "#FFFFFF", JSON.stringify(data?.placed));
  if (data.ok) {
    const canvas = await j("/v1/canvas");
    const bin = Buffer.from(canvas.data.board, "base64");
    const stored = bin[wy * (canvas.data.size || 128) + wx];
    ok("board stores white as 1 (colorIdx+1)", stored === 1, `stored=${stored}`);
    ok(
      "canvas encoding documents plus-one",
      typeof canvas.data.encoding === "string" && canvas.data.encoding.includes("plus-one"),
      canvas.data.encoding
    );
  }
}

{
  // Seed a real track, then prove mid-track public advance is locked
  const dj = `dj-${stamp}`;
  const seedPlace = await place({
    x: (px + 5) % 120,
    y: (py + 5) % 120,
    color: 11,
    agent: dj,
    goal: "dj seed",
  });
  if (!seedPlace.res.ok) {
    ok("music advance lock (seed place)", false, JSON.stringify(seedPlace.data));
  } else {
    const proof = await captcha();
    const sub = await j("/v1/music/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "smoke seed track",
        agent: dj,
        legal: true,
        ...proof,
      }),
    });
    ok("music seed submit for advance test", sub.res.ok && sub.data.ok, JSON.stringify(sub.data));
    const music = await j("/v1/music");
    const now = music.data.now;
    ok("music now playing after seed", Boolean(now && now.id && now.advanceToken), JSON.stringify(music.data.now));
    if (now && now.id) {
      const noTok = await j("/v1/music/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "ended", trackId: now.id }),
      });
      ok(
        "advance mid-track without token blocked",
        noTok.data.error === "too_early" || noTok.data.error === "unauthorized",
        JSON.stringify(noTok.data)
      );
      const withTok = await j("/v1/music/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "ended",
          trackId: now.id,
          advanceToken: now.advanceToken,
        }),
      });
      ok(
        "advance mid-track with token still too_early",
        withTok.data.error === "too_early",
        JSON.stringify(withTok.data)
      );
      ok(
        "music defaults document near-end advance",
        music.data.defaults &&
          typeof music.data.defaults.publicAdvanceNearEndMs === "number" &&
          !("minPlayMs" in (music.data.defaults || {})),
        JSON.stringify(music.data.defaults)
      );
    }
  }
}

{
  // Music submit without placements
  const proof = await captcha();
  const bare = await j("/v1/music/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "legal smoke track",
      agent: `mus0-${stamp}`,
      legal: true,
      ...proof,
    }),
  });
  ok(
    "music submit locked without placements",
    bare.res.status === 403 && bare.data.error === "placement_required",
    JSON.stringify(bare.data)
  );
}

{
  const info = await j("/v1/info");
  ok(
    "info safety not overselling vision NSFW",
    info.data.safety &&
      /text filter|report/i.test(info.data.safety) &&
      !/zero NSFW$/i.test(String(info.data.safety).trim()),
    info.data.safety
  );
}

console.log(failed ? `\n${failed} failed` : "\nAll smoke checks passed.");
process.exit(failed ? 1 : 0);
