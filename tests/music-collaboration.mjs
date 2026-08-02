#!/usr/bin/env node
import worker, { GrokPlaceCanvas } from "../worker/index.js";

class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
    this.alarmAt = null;
  }

  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (typeof key === "object" && key !== null) {
      for (const [name, item] of Object.entries(key)) this.values.set(name, item);
      return;
    }
    this.values.set(key, value);
  }
  async delete(key) { this.values.delete(key); }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function post(path, body) {
  return new Request(`https://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const storage = new MemoryStorage();
const canvas = new GrokPlaceCanvas({ storage }, {});
canvas.rateLimit = async () => ({ ok: true });
canvas.consumeProof = async () => ({ ok: true, challengeId: "test", nonce: 0, digest: "0".repeat(64) });
canvas.requireAgentCapability = async () => ({ ok: true });
canvas.readAgent = async (_key, name) => ({ name, placements: 1 });

const planBody = {
  agent: "plan-owner",
  title: "Northern glow",
  goal: "gentle music for the north edge",
  mood: "warm and patient",
  bpm: 104,
  key: "C major",
  noteBudget: 8,
  sections: [
    { id: "intro", title: "Intro", steps: 8, noteBudget: 4 },
    { id: "theme", title: "Theme", steps: 8, noteBudget: 4 },
  ],
  challengeId: "test",
  nonce: 0,
};

const badPlan = await canvas.handleMusicPlanSave(post("/internal/music/plan", { ...planBody, mood: "in the style of a famous artist" }), "*", "test");
check("music plans reject style-imitation mood prompts", badPlan.status === 400 && (await badPlan.json()).error === "bad_music_plan_mood");

const createdResponse = await canvas.handleMusicPlanSave(post("/internal/music/plan", planBody), "*", "test");
const created = await createdResponse.json();
const planId = created.plan?.id || "";
check(
  "music plans bound title, goal, tempo, key, sections, and note budget",
  createdResponse.status === 201
    && /^mp_[a-f0-9]{16}$/.test(planId)
    && created.plan?.goal === planBody.goal
    && created.plan?.sections?.length === 2
    && created.plan?.noteBudget === 8
    && created.preview?.nonMutating === true,
  JSON.stringify(created)
);

const contributor = await canvas.handleMusicPlanContribute(post("/internal/music/plan/contribute", {
  agent: "second-agent",
  planId,
  sectionId: "intro",
  notes: [
    { note: "C4", at: 0, duration: 2, velocity: 0.7 },
    { note: "E4", at: 2, duration: 2, velocity: 0.7 },
  ],
  challengeId: "test",
  nonce: 0,
}), "*", "test");
const contributorBody = await contributor.json();
check(
  "a music section records one deterministic contributor role within its local note budget",
  contributor.status === 200
    && contributorBody.section?.collaborator?.agent === "second-agent"
    && ["melody", "harmony", "bass", "rhythm", "texture"].includes(contributorBody.section?.collaborator?.role)
    && contributorBody.section?.ownerApproved === false,
  JSON.stringify(contributorBody)
);

const planBeforePreview = JSON.stringify(await storage.get(`musicplan:${planId}`));
const pendingPreviewResponse = await canvas.handleMusicPlanPreview(new URL(`https://test/internal/music/plan/preview?id=${planId}`), "*");
const pendingPreview = await pendingPreviewResponse.json();
const planAfterPreview = JSON.stringify(await storage.get(`musicplan:${planId}`));
check(
  "music preview is deterministic, warns on incomplete approval, and does not mutate plan storage",
  pendingPreviewResponse.status === 200
    && pendingPreview.preview?.nonMutating === true
    && pendingPreview.preview?.ready === false
    && pendingPreview.preview?.warnings?.length >= 1
    && planBeforePreview === planAfterPreview,
  JSON.stringify(pendingPreview)
);

const nonOwnerApproval = await canvas.handleMusicPlanApprove(post("/internal/music/plan/approve", {
  agent: "second-agent", planId, sectionId: "intro", approved: true, challengeId: "test", nonce: 0,
}), "*", "test");
check("only the authenticated plan owner can approve a contributed section", nonOwnerApproval.status === 403 && (await nonOwnerApproval.json()).error === "music_plan_owner_required");

const approvedIntro = await canvas.handleMusicPlanApprove(post("/internal/music/plan/approve", {
  agent: "plan-owner", planId, sectionId: "intro", approved: true, challengeId: "test", nonce: 0,
}), "*", "test");
check("plan owner approval is explicit and bounded to the selected section", approvedIntro.status === 200 && (await approvedIntro.json()).section?.ownerApproved === true);

const ownerContribution = await canvas.handleMusicPlanContribute(post("/internal/music/plan/contribute", {
  agent: "plan-owner",
  planId,
  sectionId: "theme",
  notes: [
    { note: "G4", at: 8, duration: 2, velocity: 0.7 },
    { note: "C5", at: 10, duration: 2, velocity: 0.7 },
  ],
  challengeId: "test",
  nonce: 0,
}), "*", "test");
check("plan owner can contribute a separate bounded section", ownerContribution.status === 200);
const approvedTheme = await canvas.handleMusicPlanApprove(post("/internal/music/plan/approve", {
  agent: "plan-owner", planId, sectionId: "theme", approved: true, challengeId: "test", nonce: 0,
}), "*", "test");
check("plan owner can approve its own explicitly contributed section", approvedTheme.status === 200 && (await approvedTheme.json()).section?.ownerApproved === true);

const readyPreviewResponse = await canvas.handleMusicPlanPreview(new URL(`https://test/internal/music/plan/preview?id=${planId}`), "*");
const readyPreview = await readyPreviewResponse.json();
check(
  "ready preview exposes deterministic score, ordered timeline, and synthesized notes without a queue write",
  readyPreview.preview?.ready === true
    && Number.isInteger(readyPreview.preview?.score)
    && readyPreview.preview?.timeline?.length === 2
    && readyPreview.preview?.composition?.notes?.length === 4
    && (await storage.get("music")) === undefined,
  JSON.stringify(readyPreview)
);

const submitted = await canvas.handleMusicSubmit(post("/internal/music/submit", {
  agent: "plan-owner",
  musicPlanId: planId,
  license: "CC0-1.0",
  original: true,
  nonInfringing: true,
  challengeId: "test",
  nonce: 0,
}), "*", "test");
const submittedBody = await submitted.json();
check(
  "only a ready approved plan compiles into deterministic CC0 queue data and schedules the alarm",
  submitted.status === 200
    && submittedBody.now?.musicPlanId === planId
    && submittedBody.now?.license === "CC0-1.0"
    && (await storage.getAlarm()) === submittedBody.now?.endsAt
    && (await storage.get(`musicplan:${planId}`))?.status === "submitted",
  JSON.stringify(submittedBody)
);

await storage.delete("mscd:plan-owner");
const secondSong = await canvas.handleMusicSubmit(post("/internal/music/submit", {
  agent: "plan-owner",
  title: "Second original",
  composition: { bpm: 104, waveform: "sine", notes: [{ note: "D4", at: 0, duration: 2, velocity: 0.7 }] },
  license: "CC0-1.0",
  original: true,
  nonInfringing: true,
  challengeId: "test",
  nonce: 0,
}), "*", "test");
check("fair queue allows a second current-or-queued composition by one contributor", secondSong.status === 200);
await storage.delete("mscd:plan-owner");
const cappedSong = await canvas.handleMusicSubmit(post("/internal/music/submit", {
  agent: "plan-owner",
  title: "Third original",
  composition: { bpm: 104, waveform: "sine", notes: [{ note: "F4", at: 0, duration: 2, velocity: 0.7 }] },
  license: "CC0-1.0",
  original: true,
  nonInfringing: true,
  challengeId: "test",
  nonce: 0,
}), "*", "test");
check("fair queue caps one contributor at two current-or-queued compositions", cappedSong.status === 409 && (await cappedSong.json()).error === "queue_agent_limit");

const fairState = {
  now: null,
  queue: [
    { id: "a-song", title: "A", submittedBy: "agent-a", votes: 9, addedAt: 1, composition: { bpm: 120, waveform: "sine", notes: [{ note: "C4", at: 0, duration: 1, velocity: 0.7 }], durationMs: 125 }, license: "CC0-1.0", originalNonInfringingAttested: true },
    { id: "b-song", title: "B", submittedBy: "agent-b", votes: 1, addedAt: 2, composition: { bpm: 120, waveform: "sine", notes: [{ note: "D4", at: 0, duration: 1, velocity: 0.7 }], durationMs: 125 }, license: "CC0-1.0", originalNonInfringingAttested: true },
  ],
  version: 3,
  lastPlayedBy: "agent-a",
};
const promoted = await canvas.promoteNext(fairState, "test-fairness");
check("fair promotion avoids an immediate contributor repeat when another contributor waits", promoted.now?.submittedBy === "agent-b" && promoted.queue?.[0]?.submittedBy === "agent-a", JSON.stringify(promoted));

const forwarded = [];
const routerEnv = {
  EDGE_READ_LIMITER: { async limit() { return { success: true }; } },
  EDGE_WRITE_LIMITER: { async limit() { return { success: true }; } },
  EDGE_CHALLENGE_LIMITER: { async limit() { return { success: true }; } },
  EDGE_LIVE_LIMITER: { async limit() { return { success: true }; } },
  CANVAS: {
    idFromName() { return "main"; },
    get() {
      return {
        async fetch(url, init) {
          forwarded.push({ path: new URL(url).pathname, method: init.method });
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        },
      };
    },
  },
};
for (const [method, path] of [
  ["GET", "/v1/music/plans"],
  ["GET", "/v1/music/plan?id=mp_1111111111111111"],
  ["GET", "/v1/music/plan/preview?id=mp_1111111111111111"],
  ["POST", "/v1/music/plan"],
  ["POST", "/v1/music/plan/contribute"],
  ["POST", "/v1/music/plan/approve"],
]) {
  await worker.fetch(new Request(`https://grokplace.barnlabs.net${path}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : {},
    body: method === "POST" ? "{}" : undefined,
  }), routerEnv);
}
check(
  "public music-plan routes retain edge limits and forward only to their matching internal handlers",
  JSON.stringify(forwarded) === JSON.stringify([
    { path: "/internal/music/plans", method: "GET" },
    { path: "/internal/music/plan", method: "GET" },
    { path: "/internal/music/plan/preview", method: "GET" },
    { path: "/internal/music/plan", method: "POST" },
    { path: "/internal/music/plan/contribute", method: "POST" },
    { path: "/internal/music/plan/approve", method: "POST" },
  ]),
  JSON.stringify(forwarded)
);

process.exitCode = failed ? 1 : 0;
