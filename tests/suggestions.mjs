#!/usr/bin/env node
import fs from "node:fs";
import { GrokPlaceCanvas } from "../worker/index.js";

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); this.writes = 0; this.tail = Promise.resolve(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    this.writes++;
    if (key && typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async transaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const transaction = {
      get: async (key) => this.values.get(key),
      put: async (key, value) => {
        this.writes++;
        if (key && typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
        else this.values.set(key, value);
      },
      delete: async (key) => { this.values.delete(key); },
    };
    try { return await callback(transaction); } finally { release(); }
  }
}

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else { failed++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const workerSource = fs.readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
check("edge proxy preserves the bounded public suggestion cache only for GET", /request\.method === "GET"[\s\S]*path === "\/internal\/suggestions"[\s\S]*if \(!cacheablePublicRead\) outHeaders\.set\("Cache-Control", "no-store"\)/.test(workerSource));
function agent(name, now = Date.now()) {
  return { name, placements: 1, votesCast: 0, upvotesReceived: 0, downvotesReceived: 0, reputation: 1, firstAt: now, lastAt: now, lastGoal: "", lastTile: null, bonusTiles: 0, maintainer: false, github: null, activePlanId: null, joinedPlanIds: [], avoidedPlanIds: [] };
}
function post(path, name, body) {
  return new Request(`https://test${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Agent ${name}-cap` }, body: JSON.stringify({ agent: name, challengeId: "test", nonce: 0, ...body }) });
}

const now = Date.now();
const storage = new MemoryStorage({
  features: [{ id: "ft_aaaaaaaaaaaaaaaa", title: "Legacy feature", summary: "Legacy feature queue record.", submittedBy: "proposer", votes: 1, voters: ["proposer"], status: "proposed", createdAt: now }],
  "agent:proposer": agent("proposer", now),
  "agent:voter-two": agent("voter-two", now),
  "agent:voter-three": agent("voter-three", now),
  "agent:stale-voter": agent("stale-voter", now - 4 * 24 * 60 * 60_000),
});
const canvas = new GrokPlaceCanvas({ storage }, {});
canvas.rateLimit = async () => ({ ok: true });
canvas.consumeProof = async () => ({ ok: true });
canvas.requireAgentCapability = async (request, name) => request.headers.get("Authorization") === `Agent ${name}-cap`
  ? { ok: true }
  : { ok: false, status: 401, error: "agent_capability_required", message: "capability required" };

let response = await canvas.handleFeatureSubmit(post("/internal/suggestions", "proposer", { title: "Improve map labels", summary: "Add clearer region labels for collaborating agents." }), "*", "test-ip", true);
let data = await response.json();
const suggestionId = data.suggestion?.id;
check("active placed agent can submit bounded untrusted suggestion", response.status === 201 && /^sg_[a-f0-9]{16}$/.test(suggestionId) && data.suggestion.votes === 1, JSON.stringify(data));

const writesBeforeRead = storage.writes;
response = await canvas.handleFeatures("*", true);
data = await response.json();
check("suggestion read is cached and creates no Durable Object writes", response.status === 200 && response.headers.get("Cache-Control") === "public, max-age=5" && storage.writes === writesBeforeRead && data.authority === "priority_only" && data.suggestions[0].id === suggestionId, JSON.stringify(data));
check("legacy feature intake cannot appear in the suggestion queue", data.suggestions.every((suggestion) => suggestion.id !== "ft_aaaaaaaaaaaaaaaa"), JSON.stringify(data));

const writesBeforeDuplicate = storage.writes;
response = await canvas.handleFeatureSubmit(post("/internal/suggestions", "proposer", { title: "Improve map labels", summary: "A retry with equivalent title must not duplicate state." }), "*", "test-ip", true);
data = await response.json();
check("suggestion submit retry returns existing record without another write", response.status === 200 && data.replayed === true && data.suggestion.id === suggestionId && storage.writes === writesBeforeDuplicate, JSON.stringify(data));

response = await canvas.handleFeatureVote(post("/internal/suggestions/vote", "voter-two", { suggestionId }), "*", "test-ip", true);
data = await response.json();
check("eligible agent vote increases priority without minting a reward", response.status === 200 && data.suggestion.votes === 2 && data.authority === "priority_only" && !Object.hasOwn(data, "tiles"), JSON.stringify(data));

const writesBeforeVoteReplay = storage.writes;
response = await canvas.handleFeatureVote(post("/internal/suggestions/vote", "voter-two", { suggestionId }), "*", "test-ip", true);
data = await response.json();
check("duplicate vote is an idempotent success before cooldown rejection", response.status === 200 && data.replayed === true && data.suggestion.votes === 2 && storage.writes === writesBeforeVoteReplay, JSON.stringify(data));

response = await canvas.handleFeatureVote(post("/internal/suggestions/vote", "stale-voter", { suggestionId }), "*", "test-ip", true);
data = await response.json();
check("inactive agent cannot vote", response.status === 403 && data.error === "active_agent_required", JSON.stringify(data));

const voters = Array.from({ length: 64 }, (_, index) => `voter-${index}`);
storage.values.set("suggestions", [{ ...(await storage.get("suggestions"))[0], votes: voters.length, voters }]);
response = await canvas.handleFeatureVote(post("/internal/suggestions/vote", "voter-three", { suggestionId }), "*", "test-ip", true);
data = await response.json();
check("per-suggestion voter cap fails closed without unbounded growth", response.status === 409 && data.error === "voter_cap" && data.maxVoters === 64, JSON.stringify(data));

storage.values.set("suggestions", []);
for (const [title, summary] of [["Improve palette", "Clarify palette roles for planned art."], ["Improve previews", "Show a clearer deterministic preview state."], ["Improve regions", "Make regional coordination bounds easier to inspect."]]) {
  response = await canvas.handleFeatureSubmit(post("/internal/suggestions", "proposer", { title, summary }), "*", "test-ip", true);
  check(`same agent may retain bounded suggestion ${title}`, response.status === 201, await response.text());
}
response = await canvas.handleFeatureSubmit(post("/internal/suggestions", "proposer", { title: "Fourth proposal", summary: "This proposal must hit the retained per-agent cap." }), "*", "test-ip", true);
data = await response.json();
check("one agent cannot monopolize suggestion retention", response.status === 429 && data.error === "agent_suggestion_cap" && data.maxRetainedPerAgent === 3, JSON.stringify(data));

const fullQueue = Array.from({ length: 64 }, (_, index) => ({ id: `sg_${index.toString(16).padStart(16, "0")}`, title: `Queue item ${index}`, summary: "Bounded queue capacity fixture.", submittedBy: `agent-${index}`, votes: 1, voters: [`agent-${index}`], status: "proposed", createdAt: now + index }));
storage.values.set("suggestions", fullQueue);
response = await canvas.handleFeatureSubmit(post("/internal/suggestions", "proposer", { title: "Queue overflow", summary: "A full queue must reject additional retained state." }), "*", "test-ip", true);
data = await response.json();
check("full suggestion queue fails closed without evicting another agent", response.status === 429 && data.error === "queue_full" && (await storage.get("suggestions")).length === 64, JSON.stringify(data));

const old = { ...fullQueue[0], id: "sg_1111111111111111", createdAt: now - 91 * 24 * 60 * 60_000 };
storage.values.set("suggestions", [old]);
const writesBeforeExpiredRead = storage.writes;
response = await canvas.handleFeatures("*", true);
data = await response.json();
check("expired suggestions disappear on reads without cleanup writes", response.status === 200 && data.suggestions.length === 0 && storage.writes === writesBeforeExpiredRead, JSON.stringify(data));

process.exitCode = failed ? 1 : 0;
