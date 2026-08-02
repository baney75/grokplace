import { GrokPlaceCanvas } from "../worker/index.js";

const REVIEW_HOST = "grokplace.projectbarnlab.workers.dev";
const BODY_LIMIT = 64 * 1024;
const EVIDENCE_ROUTES = new Map([
  ["GET /v1/reviews", "/internal/reviews"],
  ["GET /v1/challenge", "/internal/challenge"],
  ["POST /v1/reviews/claim", "/internal/reviews/claim"],
  ["POST /v1/reviews/attest", "/internal/reviews/attest"],
]);
const CHALLENGE_SCOPES = new Set(["review:claim", "review:attest"]);

/** @typedef {Pick<Env, "CANVAS" | "EDGE_READ_LIMITER" | "EDGE_WRITE_LIMITER" | "EDGE_CHALLENGE_LIMITER" | "CANVAS_SIZE" | "COOLDOWN_MS">} MaintenanceEnv */

/** @param {Record<string, string>} [extra] */
function headers(extra = {}) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function maintenanceResponse() {
  return new Response("grok/place is briefly offline while polling protection is installed. Please retry shortly.\n", {
    status: 503,
    headers: headers({
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "900",
    }),
  });
}

function notFoundResponse() {
  return new Response("Not found\n", { status: 404, headers: headers({ "content-type": "text/plain; charset=utf-8" }) });
}

/** @param {string} hostname */
function isWorkersDevHost(hostname) {
  // URL preserves a terminal DNS root label, so normalize it before the suffix check.
  return hostname.toLowerCase().replace(/\.+$/, "").endsWith(".workers.dev");
}

/** @param {Request} request */
function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

/** @param {string} value */
async function shortHash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {RateLimit} limiter @param {Request} request @param {string} bucket */
async function rateLimited(limiter, request, bucket) {
  try {
    const result = await limiter.limit({ key: await shortHash(`${clientIp(request)}:${bucket}`) });
    return result.success === false;
  } catch (error) {
    console.error("maintenance evidence limiter unavailable", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** @param {Request} request */
async function readBodyLimited(request) {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BODY_LIMIT) {
        await reader.cancel("request body too large");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/** @param {MaintenanceEnv} env @param {string} internalPath @param {Request} request */
async function forwardEvidence(env, internalPath, request) {
  const url = new URL(request.url);
  url.hostname = "grokplace.barnlabs.net";
  url.pathname = internalPath;
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set("X-Forwarded-Origin", request.headers.get("Origin") || "*");
  forwardedHeaders.set("X-Canvas-Size", env.CANVAS_SIZE);
  forwardedHeaders.set("X-Cooldown-Ms", env.COOLDOWN_MS);
  forwardedHeaders.set("X-Client-IP", clientIp(request));
  /** @type {RequestInit} */
  const init = { method: request.method, headers: forwardedHeaders };
  if (request.method === "POST") {
    const body = await readBodyLimited(request);
    if (body === null) {
      return new Response(JSON.stringify({ ok: false, error: "request_too_large" }), {
        status: 413,
        headers: headers({ "content-type": "application/json; charset=utf-8", "retry-after": "60" }),
      });
    }
    init.body = body;
  }
  const response = await env.CANVAS.get(env.CANVAS.idFromName("main")).fetch(url.toString(), init);
  const responseHeaders = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers())) responseHeaders.set(name, value);
  if (request.method === "GET" && internalPath === "/internal/reviews" && response.ok) {
    responseHeaders.set("cache-control", "public, max-age=60, immutable");
  }
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export default {
  /** @param {Request} request @param {MaintenanceEnv} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== REVIEW_HOST) {
      return isWorkersDevHost(url.hostname) ? notFoundResponse() : maintenanceResponse();
    }

    const method = request.method.toUpperCase();
    const routeKey = `${method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
    const internalPath = EVIDENCE_ROUTES.get(routeKey);
    if (!internalPath) return notFoundResponse();
    if (internalPath === "/internal/challenge" && !CHALLENGE_SCOPES.has(url.searchParams.get("scope") || "")) {
      return new Response(JSON.stringify({ ok: false, error: "scope_not_available_during_maintenance" }), {
        status: 400,
        headers: headers({ "content-type": "application/json; charset=utf-8" }),
      });
    }

    const contentLength = Number(request.headers.get("Content-Length"));
    if (method === "POST" && Number.isFinite(contentLength) && contentLength > BODY_LIMIT) {
      return new Response(JSON.stringify({ ok: false, error: "request_too_large" }), {
        status: 413,
        headers: headers({ "content-type": "application/json; charset=utf-8", "retry-after": "60" }),
      });
    }

    const limiter = method === "GET" && internalPath === "/internal/reviews"
      ? env.EDGE_READ_LIMITER
      : method === "GET"
        ? env.EDGE_CHALLENGE_LIMITER
        : env.EDGE_WRITE_LIMITER;
    const limited = await rateLimited(limiter, request, method === "GET" ? internalPath : "evidence-write");
    if (limited === null) {
      return new Response(JSON.stringify({ ok: false, error: "rate_limiter_unavailable" }), {
        status: 503,
        headers: headers({ "content-type": "application/json; charset=utf-8", "retry-after": "30" }),
      });
    }
    if (limited) {
      return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
        status: 429,
        headers: headers({ "content-type": "application/json; charset=utf-8", "retry-after": "60" }),
      });
    }
    return forwardEvidence(env, internalPath, request);
  },
};

// Cloudflare requires the existing class export in every version that shares its DO namespace.
// Keeping the real class also lets scheduled music alarms remain safe while HTTP is offline.
export { GrokPlaceCanvas };
