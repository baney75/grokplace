/**
 * Smoke tests against a running Grok Place API.
 * Usage: API=https://... node scripts/smoke-test.mjs
 */
const API = (process.env.API || "http://127.0.0.1:8787").replace(/\/$/, "");

let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
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
    data = { _raw: text };
  }
  return { res, data };
}

const agent = `test-${Date.now().toString(36).slice(-6)}`;

console.log(`Smoke → ${API}\n`);

{
  const { res, data } = await j("/health");
  ok("GET /health", res.ok && data.ok);
}

{
  const { res, data } = await j("/v1/info");
  ok("GET /v1/info", res.ok && data.ok && Array.isArray(data.palette) && data.palette.length === 16);
  ok("info has curlExample", typeof data.curlExample === "string" && data.curlExample.includes("/v1/place"));
  ok("info has agentPrompt", typeof data.agentPrompt === "string" && data.agentPrompt.includes("curl"));
}

{
  const { res, data } = await j("/v1/canvas");
  ok("GET /v1/canvas", res.ok && data.ok && data.board && data.size === 128);
}

{
  const { res, data } = await j("/v1/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x: 10,
      y: 11,
      color: "#E50000",
      agent,
      goal: "smoke test",
    }),
  });
  ok("POST /v1/place", res.ok && data.ok, JSON.stringify(data));
  ok("place returns nextPlaceAt", data.ok && typeof data.nextPlaceAt === "number");
  ok("place returns remainingSec", data.ok && data.remainingSec > 0);
}

{
  const { res, data } = await j("/v1/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 12, y: 11, color: 5, agent }),
  });
  ok("cooldown 429", res.status === 429 && data.error === "cooldown", `status=${res.status}`);
  ok("cooldown remainingSec", data.remainingSec >= 1);
}

{
  const { res, data } = await j(`/v1/status?agent=${agent}`);
  ok("GET /v1/status", res.ok && data.ok && data.canPlace === false);
}

{
  const { res, data } = await j("/v1/feed");
  ok("GET /v1/feed has entry", res.ok && data.ok && data.feed.some((e) => e.agent === agent));
}

{
  const { res, data } = await j("/v1/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 999, y: 0, color: 1, agent: "other-ok" }),
  });
  ok("bad coords 400", res.status === 400 && data.error === "bad_coords");
}

console.log(failed ? `\n${failed} failed` : "\nAll smoke checks passed.");
process.exit(failed ? 1 : 0);
