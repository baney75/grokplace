#!/usr/bin/env node
import maintenanceWorker from "../ops/maintenance-worker.js";

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function testEnv({ limiterError = false } = {}) {
  const calls = [];
  const limiter = {
    async limit(request) {
      if (limiterError) throw new Error("simulated limiter failure");
      calls.push({ type: "limit", request });
      return { success: true };
    },
  };
  const stub = {
    async fetch(url, init) {
      calls.push({ type: "do", url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "public, max-age=60, immutable" },
      });
    },
  };
  return {
    calls,
    env: {
      CANVAS: { idFromName: () => "main-id", get: () => stub },
      EDGE_READ_LIMITER: limiter,
      EDGE_WRITE_LIMITER: limiter,
      EDGE_CHALLENGE_LIMITER: limiter,
      CANVAS_SIZE: "128",
      COOLDOWN_MS: "30000",
    },
  };
}

{
  const { env, calls } = testEnv();
  const response = await maintenanceWorker.fetch(new Request("https://grokplace.barnlabs.net/v1/reviews?id=rv_deadbeef"), env);
  check("branded host remains fully offline", response.status === 503 && response.headers.get("cache-control") === "no-store" && calls.length === 0);
}

{
  const { env, calls } = testEnv();
  const response = await maintenanceWorker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/canvas"), env);
  check("direct host rejects every non-evidence route without a binding call", response.status === 404 && calls.length === 0);
}

{
  const { env, calls } = testEnv();
  const response = await maintenanceWorker.fetch(new Request("https://version-123.grokplace.projectbarnlab.workers.dev/v1/canvas"), env);
  check("versioned workers.dev hosts are noncanonical and return 404 without a binding call", response.status === 404 && calls.length === 0);
}

{
  const { env, calls } = testEnv();
  const response = await maintenanceWorker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev./v1/canvas"), env);
  check("a trailing-dot workers.dev host is noncanonical and returns 404 without a binding call", response.status === 404 && calls.length === 0);
}

{
  const { env, calls } = testEnv();
  const response = await maintenanceWorker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/challenge?scope=place"), env);
  check("maintenance challenge rejects non-evidence scopes before rate limit or DO", response.status === 400 && calls.length === 0);
}

{
  const { env, calls } = testEnv();
  const response = await maintenanceWorker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/agent/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "reviewer" }),
  }), env);
  const forwarded = calls.find((call) => call.type === "do");
  check(
    "maintenance claim is rate-limited and forwards only to the internal claim writer",
    response.status === 200
      && calls.filter((call) => call.type === "limit").length === 1
      && forwarded
      && new URL(forwarded.url).pathname === "/internal/agent/claim"
  );
}

{
  const { env, calls } = testEnv();
  const response = await maintenanceWorker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/reviews?id=rv_0123456789abcdef0123456789abcdef", {
    headers: { "CF-Connecting-IP": "192.0.2.8" },
  }), env);
  const forwarded = calls.find((call) => call.type === "do");
  check(
    "review mirror is rate-limited and forwards only to the internal review reader",
    response.status === 200
      && calls.filter((call) => call.type === "limit").length === 1
      && forwarded
      && new URL(forwarded.url).pathname === "/internal/reviews"
      && new URL(forwarded.url).searchParams.get("id") === "rv_0123456789abcdef0123456789abcdef"
  );
}

{
  const { env, calls } = testEnv();
  const response = await maintenanceWorker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/reviews/attest", {
    method: "POST",
    headers: { Authorization: "Agent placeholder", "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "critic" }),
  }), env);
  const forwarded = calls.find((call) => call.type === "do");
  check(
    "attestation keeps authorization private and forwards only to the internal attestation writer",
    response.status === 200
      && forwarded
      && new URL(forwarded.url).pathname === "/internal/reviews/attest"
      && forwarded.init.headers.get("Authorization") === "Agent placeholder"
  );
}

{
  const { env, calls } = testEnv({ limiterError: true });
  const response = await maintenanceWorker.fetch(new Request("https://grokplace.projectbarnlab.workers.dev/v1/reviews?id=rv_0123456789abcdef0123456789abcdef"), env);
  check("maintenance evidence fails closed when its limiter fails", response.status === 503 && calls.every((call) => call.type !== "do"));
}

if (failed) process.exit(1);
