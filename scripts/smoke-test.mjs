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

const agent = `test-${Date.now().toString(36).slice(-6)}`;
const agent2 = `test2-${Date.now().toString(36).slice(-6)}`;

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
    x: 10,
    y: 11,
    color: "#E50000",
    agent,
    goal: "smoke test art",
  });
  ok("POST /v1/place with captcha", res.ok && data.ok, JSON.stringify(data));
  ok("place returns nextPlaceAt", data.ok && typeof data.nextPlaceAt === "number");
  ok("place returns reputation", data.ok && data.reputation >= 1);
}

{
  const { res, data } = await place({ x: 12, y: 11, color: 5, agent });
  ok("cooldown 429", res.status === 429 && data.error === "cooldown", `status=${res.status}`);
}

{
  const { res, data } = await j(`/v1/status?agent=${agent}`);
  ok("GET /v1/status", res.ok && data.ok && data.canPlace === false);
  ok("status has memory", data.memory && data.memory.placements >= 1);
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
  const novote = await vote({
    x: 10,
    y: 11,
    dir: 1,
    agent: `novote-${Date.now().toString(36).slice(-4)}`,
  });
  ok("vote locked without placements", novote.res.status === 403 && novote.data.error === "vote_locked");
}

{
  // agent2 places cleanly then votes on agent's tile
  const p = await place({ x: 15, y: 15, color: 11, agent: agent2, goal: "cyan pixel" });
  ok("second agent place", p.res.ok && p.data.ok, JSON.stringify(p.data));
  const v = await vote({ x: 10, y: 11, dir: 1, agent: agent2 });
  ok("POST /v1/vote upvote", v.res.ok && v.data.ok, JSON.stringify(v.data));
  ok("vote returns score", v.data.ok && typeof v.data.vote?.score === "number");

  // rapid re-vote hits vote cooldown (flip allowed after cooldown; accounting is reverse-then-apply)
  const flip = await vote({ x: 10, y: 11, dir: -1, agent: agent2 });
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
  const a = `conc-a-${Date.now().toString(36).slice(-4)}`;
  const b = `conc-b-${Date.now().toString(36).slice(-4)}`;
  const [r1, r2] = await Promise.all([
    place({ x: 70, y: 70, color: 5, agent: a, goal: "conc-a" }),
    place({ x: 71, y: 70, color: 11, agent: b, goal: "conc-b" }),
  ]);
  ok("concurrent place A", r1.res.ok && r1.data.ok, JSON.stringify(r1.data));
  ok("concurrent place B", r2.res.ok && r2.data.ok, JSON.stringify(r2.data));
  const { data: canvas } = await j("/v1/canvas?format=sparse");
  const tiles = canvas.tiles || [];
  ok(
    "concurrent both pixels",
    tiles.some((t) => t.x === 70 && t.y === 70 && t.c === 5) &&
      tiles.some((t) => t.x === 71 && t.y === 70 && t.c === 11)
  );
}

// reuse captcha should fail
{
  const ch = await j("/v1/challenge");
  const nonce = solvePow(ch.data.challenge, ch.data.difficulty);
  const first = await j("/v1/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x: 80,
      y: 80,
      color: 2,
      agent: `reuse-${Date.now().toString(36).slice(-4)}`,
      challengeId: ch.data.challengeId,
      nonce,
    }),
  });
  ok("first use of challenge ok", first.res.ok && first.data.ok, JSON.stringify(first.data));
  const second = await j("/v1/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x: 81,
      y: 80,
      color: 2,
      agent: `reuse2-${Date.now().toString(36).slice(-4)}`,
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

console.log(failed ? `\n${failed} failed` : "\nAll smoke checks passed.");
process.exit(failed ? 1 : 0);
