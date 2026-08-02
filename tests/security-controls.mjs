#!/usr/bin/env node
import { readFileSync } from "node:fs";
import worker from "../worker/index.js";

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function envWithRoute(routed, limiterResult = { success: true }) {
  return {
    EDGE_READ_LIMITER: { async limit({ key }) { return { ...limiterResult, key }; } },
    EDGE_WRITE_LIMITER: { async limit({ key }) { return { ...limiterResult, key }; } },
    EDGE_LIVE_LIMITER: { async limit({ key }) { return { ...limiterResult, key }; } },
    EDGE_CHALLENGE_LIMITER: { async limit({ key }) { return { ...limiterResult, key }; } },
    CANVAS: {
      idFromName() { return "main"; },
      get() {
        routed.value = true;
        return { fetch: async () => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }) };
      },
    },
  };
}

const EDGE_REQUEST_BODY_MAX_BYTES = 64 * 1024;
const staticHeaders = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

check(
  "static viewer CSP permits the branded API for GitHub Pages",
  /connect-src 'self' https:\/\/grokplace\.barnlabs\.net wss:\/\/grokplace\.barnlabs\.net/.test(staticHeaders)
);

{
  const keys = [];
  const routed = { value: false };
  const env = envWithRoute(routed);
  env.EDGE_CHALLENGE_LIMITER = { async limit({ key }) { keys.push(key); return { success: true }; } };
  await worker.fetch(new Request("https://grokplace.barnlabs.net/v1/challenge?scope=not-a-scope-one", {
    headers: { "CF-Connecting-IP": "2001:db8:1234:5678:90ab:cdef:1234:5678" },
  }), env);
  await worker.fetch(new Request("https://grokplace.barnlabs.net/v1/challenge?scope=not-a-scope-two", {
    headers: { "CF-Connecting-IP": "2001:db8:1234:5678:90ab:cdef:1234:5678" },
  }), env);
  check("invalid challenge scopes share one bounded edge bucket", keys.length === 2 && keys[0] === keys[1] && keys[0].length === 32);
}

{
  const keys = [];
  const env = envWithRoute({ value: false });
  env.EDGE_READ_LIMITER = { async limit({ key }) { keys.push(key); return { success: true }; } };
  for (const path of ["/v1/canvas", "/v1/feed", "/v1/music", "/v1/suggestions", "/v1/see", "/v1/snapshot", "/v1/view", "/see", "/v1/tile?x=0&y=0", "/v1/goals?x=0&y=0&w=1&h=1"]) {
    await worker.fetch(new Request(`https://grokplace.barnlabs.net${path}`, {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    }), env);
  }
  check("all public read aliases share one bounded edge bucket", keys.length === 10 && new Set(keys).size === 1);
}

{
  const keys = [];
  const env = envWithRoute({ value: false });
  env.EDGE_WRITE_LIMITER = { async limit({ key }) { keys.push(key); return { success: true }; } };
  for (const path of ["/v1/place", "/v1/protect", "/v1/goals/join", "/v1/vote", "/v1/music/vote", "/v1/features/vote", "/v1/suggestions", "/v1/suggestions/vote"]) {
    await worker.fetch(new Request(`https://grokplace.barnlabs.net${path}`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.9", "Content-Type": "application/json" },
      body: "{}",
    }), env);
  }
  check("all public mutations share one bounded edge bucket", keys.length === 8 && new Set(keys).size === 1);
}

{
  const routed = { value: false };
  const response = await worker.fetch(new Request("https://grokplace.barnlabs.net/v1/canvas", {
    headers: { "CF-Connecting-IP": "203.0.113.10" },
  }), envWithRoute(routed, { success: false }));
  const body = await response.json();
  check("edge read limiter returns 429 before Durable Object access", response.status === 429 && body.error === "rate_limited" && !routed.value);
  check("edge read limiter sends a bounded retry policy", response.headers.get("Retry-After") === "60" && response.headers.get("X-RateLimit-Policy") === "30/60s per client");
}

{
  const routed = { value: false };
  const response = await worker.fetch(new Request("https://grokplace.barnlabs.net/v1/canvas", {
    headers: { "CF-Connecting-IP": "203.0.113.11" },
  }), envWithRoute(routed));
  check("allowed public reads still reach the Durable Object", response.status === 200 && routed.value);
  const see = await worker.fetch(new Request("https://grokplace.barnlabs.net/see", {
    headers: { "CF-Connecting-IP": "203.0.113.11" },
  }), envWithRoute({ value: false }, { success: true }));
  check("public see alias remains an edge-limited read", see.status === 200);
  const health = await worker.fetch(new Request("https://grokplace.barnlabs.net/health", {
    headers: { "CF-Connecting-IP": "203.0.113.11" },
  }), envWithRoute({ value: false }));
  check("Worker-owned responses carry baseline security headers", health.headers.get("X-Content-Type-Options") === "nosniff" && health.headers.get("Referrer-Policy") === "no-referrer");
  const bootstrap = await worker.fetch(new Request("https://grokplace.barnlabs.net/", {
    headers: { Accept: "text/plain", "User-Agent": "curl/8.7.1", "CF-Connecting-IP": "203.0.113.11" },
  }), envWithRoute({ value: false }));
  check("negotiated agent bootstrap is not shared-cacheable", bootstrap.headers.get("Cache-Control") === "no-store" && bootstrap.headers.get("Vary")?.includes("Accept"));
}

{
  const routed = { value: false };
  const response = await worker.fetch(new Request("https://grokplace.barnlabs.net/v1/canvas", {
    method: "OPTIONS",
    headers: { Origin: "https://viewer.test", "CF-Connecting-IP": "203.0.113.13" },
  }), envWithRoute(routed, { success: false }));
  const body = await response.json();
  check("preflight requests are rate limited before Durable Object access", response.status === 429 && body.error === "rate_limited" && !routed.value);
}

{
  const response = await worker.fetch(new Request("https://grokplace.barnlabs.net/v1/canvas", {
    method: "OPTIONS",
    headers: { Origin: "https://viewer.test", "CF-Connecting-IP": "203.0.113.14" },
  }), envWithRoute({ value: false }));
  check("preflight responses are explicitly uncached and origin-varying", response.status === 204 && response.headers.get("Cache-Control") === "no-store" && response.headers.get("Vary") === "Origin");
}

{
  const response = await worker.fetch(new Request("https://grokplace.barnlabs.net/v1/reviews?id=rv_11111111111111111111111111111111", {
    headers: { "CF-Connecting-IP": "203.0.113.16" },
  }), {
    EDGE_READ_LIMITER: { async limit() { return { success: true }; } },
    CANVAS: {
      idFromName() { return "main"; },
      get() {
        return { fetch: async () => new Response(JSON.stringify({ ok: true, review: {} }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60, immutable" } }) };
      },
    },
  });
  check("immutable review evidence keeps its public cache policy", response.status === 200 && response.headers.get("Cache-Control") === "public, max-age=60, immutable");
}

{
  const routed = { value: false };
  const env = envWithRoute(routed);
  const response = await worker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/reviews?id=rv_11111111111111111111111111111111", {
    headers: { "CF-Connecting-IP": "203.0.113.17" },
  }), env);
  const blocked = await worker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/canvas", {
    headers: { "CF-Connecting-IP": "203.0.113.17" },
  }), env);
  const previewBlocked = await worker.fetch(new Request("https://version-123.grokplace.projectbarnlab.workers.dev/v1/canvas", {
    headers: { "CF-Connecting-IP": "203.0.113.17" },
  }), env);
  const reviewClaimBlocked = await worker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/reviews/claim", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.17", "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }), env);
  const maintainers = await worker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/maintainers", {
    headers: { "CF-Connecting-IP": "203.0.113.18" },
  }), env);
  const reservations = await worker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/maintain/reservations", {
    headers: { "CF-Connecting-IP": "203.0.113.19", Authorization: "Bearer test-secret" },
  }), env);
  const award = await worker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/maintain/award", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.20", Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: "{}",
  }), env);
  const previewAwardBlocked = await worker.fetch(new Request("https://version-123.grokplace.projectbarnlab.workers.dev/v1/maintain/award", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.21", Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: "{}",
  }), env);
  const terminalDotBlocked = await worker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev./v1/canvas", {
    headers: { "CF-Connecting-IP": "203.0.113.17" },
  }), env);
  check("direct review mirror reaches only the immutable review route", response.status === 200 && routed.value);
  check("direct review mirror blocks application paths", blocked.status === 404 && (await blocked.text()).trim() === "Not found");
  check("version preview hosts also block application paths", previewBlocked.status === 404 && (await previewBlocked.text()).trim() === "Not found");
  check("normal direct mirror blocks review-claim writes", reviewClaimBlocked.status === 404 && (await reviewClaimBlocked.text()).trim() === "Not found");
  check("canonical direct host reaches only trusted maintenance machine routes", maintainers.status === 200 && reservations.status === 200 && award.status === 200);
  check("version preview hosts block trusted maintenance writes", previewAwardBlocked.status === 404 && (await previewAwardBlocked.text()).trim() === "Not found");
  check("terminal-dot direct hosts also block application paths", terminalDotBlocked.status === 404 && (await terminalDotBlocked.text()).trim() === "Not found");
  check("direct-host errors are never cacheable", blocked.headers.get("Cache-Control") === "no-store" && previewBlocked.headers.get("Cache-Control") === "no-store" && terminalDotBlocked.headers.get("Cache-Control") === "no-store");
}

{
  const routed = { value: false };
  const response = await worker.fetch(new Request("https://grokplace.barnlabs.net/v1/place", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.12", "Content-Length": "65537" },
    body: "{}",
  }), envWithRoute(routed));
  const body = await response.json();
  check("oversized mutation bodies are rejected at the edge", response.status === 413 && body.error === "request_too_large" && !routed.value);
}

{
  const routed = { value: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(EDGE_REQUEST_BODY_MAX_BYTES + 1));
      controller.close();
    },
  });
  const request = new Request("https://grokplace.barnlabs.net/v1/place", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.15", "Content-Type": "application/json" },
    body,
    duplex: "half",
  });
  const response = await worker.fetch(request, envWithRoute(routed));
  const data = await response.json();
  check("streamed mutation bodies are bounded without Content-Length", !request.headers.has("Content-Length") && response.status === 413 && data.error === "request_too_large" && !routed.value, JSON.stringify(data));
}

process.exitCode = failed ? 1 : 0;
