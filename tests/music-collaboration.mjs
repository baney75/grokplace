#!/usr/bin/env node
import worker, { GrokPlaceCanvas } from "../worker/index.js";

class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
    this.alarmAt = null;
    this.tail = Promise.resolve();
    this.transactionCount = 0;
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
  async transaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    this.transactionCount++;
    const transaction = {
      get: (key) => this.get(key),
      put: (key, value) => this.put(key, value),
      delete: (key) => this.delete(key),
      getAlarm: () => this.getAlarm(),
      setAlarm: (at) => this.setAlarm(at),
      deleteAlarm: () => this.deleteAlarm(),
    };
    try { return await callback(transaction); } finally { release(); }
  }
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
const rateLimitSuccess = async () => ({ ok: true });
const rateLimited = async () => ({ ok: false });
canvas.rateLimit = rateLimitSuccess;
const proofSuccess = async () => ({ ok: true, challengeId: "test", nonce: 0, digest: "0".repeat(64) });
const proofAlreadyUsed = async () => ({ ok: false, status: 409, error: "captcha_used", message: "Proof was already used." });
canvas.consumeProof = proofSuccess;
canvas.requireAgentCapability = async () => ({ ok: true });
canvas.readAgent = async (_key, name) => ({ name, placements: 1 });

const planBody = {
  agent: "plan-owner",
  clientRequestId: "music-plan-create-001",
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

canvas.consumeProof = proofAlreadyUsed;
canvas.rateLimit = rateLimited;
const createdReplayResponse = await canvas.handleMusicPlanSave(post("/internal/music/plan", planBody), "*", "test");
canvas.consumeProof = proofSuccess;
canvas.rateLimit = rateLimitSuccess;
const createdReplay = await createdReplayResponse.json();
check(
  "music-plan creation retries return the original durable plan without another proof, rate-limit check, or duplication",
  createdReplayResponse.status === 201
    && createdReplay.replayed === true
    && createdReplay.plan?.id === planId
    && (await storage.get("musicPlans"))?.filter((id) => id === planId).length === 1,
  JSON.stringify(createdReplay)
);

const introContribution = {
  agent: "second-agent",
  clientRequestId: "music-intro-contribution-001",
  planId,
  sectionId: "intro",
  notes: [
    { note: "C4", at: 0, duration: 2, velocity: 0.7 },
    { note: "E4", at: 2, duration: 2, velocity: 0.7 },
  ],
  challengeId: "test",
  nonce: 0,
};
const contributor = await canvas.handleMusicPlanContribute(post("/internal/music/plan/contribute", introContribution), "*", "test");
const contributorBody = await contributor.json();
check(
  "a music section records one deterministic contributor role within its local note budget",
  contributor.status === 200
    && contributorBody.section?.collaborator?.agent === "second-agent"
    && ["melody", "harmony", "bass", "rhythm", "texture"].includes(contributorBody.section?.collaborator?.role)
    && contributorBody.section?.ownerApproved === false,
  JSON.stringify(contributorBody)
);

const planBeforeContributionReplay = JSON.stringify(await storage.get(`musicplan:${planId}`));
canvas.consumeProof = proofAlreadyUsed;
canvas.rateLimit = rateLimited;
const contributionReplayResponse = await canvas.handleMusicPlanContribute(post("/internal/music/plan/contribute", introContribution), "*", "test");
canvas.consumeProof = proofSuccess;
canvas.rateLimit = rateLimitSuccess;
const contributionReplay = await contributionReplayResponse.json();
check(
  "music contribution retries return their durable result without another proof, rate-limit check, or mutation",
  contributionReplayResponse.status === 200
    && contributionReplay.replayed === true
    && contributionReplay.section?.collaborator?.agent === "second-agent"
    && JSON.stringify(await storage.get(`musicplan:${planId}`)) === planBeforeContributionReplay,
  JSON.stringify(contributionReplay)
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
    && pendingPreview.preview?.composition === null
    && pendingPreview.preview?.warnings?.length >= 1
    && planBeforePreview === planAfterPreview,
  JSON.stringify(pendingPreview)
);

const nonOwnerApproval = await canvas.handleMusicPlanApprove(post("/internal/music/plan/approve", {
  agent: "second-agent", clientRequestId: "music-non-owner-approval", planId, sectionId: "intro", approved: true, challengeId: "test", nonce: 0,
}), "*", "test");
check("only the authenticated plan owner can approve a contributed section", nonOwnerApproval.status === 403 && (await nonOwnerApproval.json()).error === "music_plan_owner_required");

const introApproval = { agent: "plan-owner", clientRequestId: "music-intro-approval-001", planId, sectionId: "intro", approved: true, challengeId: "test", nonce: 0 };
const approvedIntro = await canvas.handleMusicPlanApprove(post("/internal/music/plan/approve", introApproval), "*", "test");
check("plan owner approval is explicit and bounded to the selected section", approvedIntro.status === 200 && (await approvedIntro.json()).section?.ownerApproved === true);

canvas.consumeProof = proofAlreadyUsed;
const approvalReplayResponse = await canvas.handleMusicPlanApprove(post("/internal/music/plan/approve", introApproval), "*", "test");
canvas.consumeProof = proofSuccess;
const approvalReplay = await approvalReplayResponse.json();
check("music approval retries return their durable result without another proof or mutation", approvalReplayResponse.status === 200 && approvalReplay.replayed === true && approvalReplay.section?.ownerApproved === true, JSON.stringify(approvalReplay));

const ownerContribution = await canvas.handleMusicPlanContribute(post("/internal/music/plan/contribute", {
  agent: "plan-owner",
  clientRequestId: "music-theme-contribution-001",
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
  agent: "plan-owner", clientRequestId: "music-theme-approval-001", planId, sectionId: "theme", approved: true, challengeId: "test", nonce: 0,
}), "*", "test");
check("plan owner can approve its own explicitly contributed section", approvedTheme.status === 200 && (await approvedTheme.json()).section?.ownerApproved === true);

const racePlanResponse = await canvas.handleMusicPlanSave(post("/internal/music/plan", {
  ...planBody,
  agent: "race-owner",
  clientRequestId: "music-race-create-001",
  title: "Concurrent sections",
}), "*", "test");
const racePlan = await racePlanResponse.json();
const racePlanId = racePlan.plan?.id || "";
const raceResponses = await Promise.all([
  canvas.handleMusicPlanContribute(post("/internal/music/plan/contribute", {
    agent: "race-first", clientRequestId: "music-race-intro-first", planId: racePlanId, sectionId: "intro",
    notes: [{ note: "C4", at: 0, duration: 2, velocity: 0.7 }], challengeId: "test", nonce: 0,
  }), "*", "test"),
  canvas.handleMusicPlanContribute(post("/internal/music/plan/contribute", {
    agent: "race-second", clientRequestId: "music-race-intro-second", planId: racePlanId, sectionId: "intro",
    notes: [{ note: "D4", at: 0, duration: 2, velocity: 0.7 }], challengeId: "test", nonce: 0,
  }), "*", "test"),
  canvas.handleMusicPlanContribute(post("/internal/music/plan/contribute", {
    agent: "race-owner", clientRequestId: "music-race-theme-owner", planId: racePlanId, sectionId: "theme",
    notes: [{ note: "G4", at: 8, duration: 2, velocity: 0.7 }], challengeId: "test", nonce: 0,
  }), "*", "test"),
]);
const raceResults = await Promise.all(raceResponses.map(async (response) => ({ status: response.status, data: await response.json() })));
const raceStored = await storage.get(`musicplan:${racePlanId}`);
const introRace = raceResults.filter((result) => result.data.section?.id === "intro");
check(
  "transactional music contributions preserve distinct sections while one same-section claimant wins and one receives 409",
  racePlanResponse.status === 201
    && raceResults.filter((result) => result.status === 200).length === 2
    && raceResults.filter((result) => result.status === 409 && result.data.error === "section_claimed").length === 1
    && raceStored?.sections?.filter((section) => section.contribution).length === 2
    && introRace.some((result) => result.status === 200)
    && storage.transactionCount >= 10,
  JSON.stringify(raceResults)
);

const replayKey = "musicplan:requests:race-owner";
const replaySeed = Array.from({ length: 33 }, (_, index) => ({
  version: 1,
  clientRequestId: `retained-approval-${String(index).padStart(2, "0")}`,
  action: "approve",
  requestHash: "a".repeat(64),
  createdAt: Date.now(),
  status: 200,
  result: { ok: true },
}));
replaySeed.push({ ...replaySeed[0], clientRequestId: "expired-approval-00", createdAt: Date.now() - 25 * 60 * 60 * 1_000 });
await storage.put(replayKey, replaySeed);
const replayCleanup = await canvas.handleMusicPlanApprove(post("/internal/music/plan/approve", {
  agent: "race-owner", clientRequestId: "music-race-cleanup-approval", planId: racePlanId, sectionId: "theme", approved: true, challengeId: "test", nonce: 0,
}), "*", "test");
const retainedReplays = await storage.get(replayKey);
check(
  "music replay storage drops expired records and remains bounded per agent",
  replayCleanup.status === 200
    && Array.isArray(retainedReplays)
    && retainedReplays.length === 32
    && retainedReplays.every((record) => record.clientRequestId !== "expired-approval-00")
    && retainedReplays.some((record) => record.clientRequestId === "music-race-cleanup-approval"),
  JSON.stringify(retainedReplays)
);

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

const planSubmitBody = {
  agent: "plan-owner",
  clientRequestId: "music-plan-submit-001",
  musicPlanId: planId,
  license: "CC0-1.0",
  original: true,
  nonInfringing: true,
  challengeId: "test",
  nonce: 0,
};
const submitted = await canvas.handleMusicSubmit(post("/internal/music/submit", planSubmitBody), "*", "test");
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

const musicBeforeSubmitReplay = JSON.stringify(await storage.get("music"));
const planBeforeSubmitReplay = JSON.stringify(await storage.get(`musicplan:${planId}`));
canvas.consumeProof = proofAlreadyUsed;
canvas.rateLimit = rateLimited;
const submittedReplayResponse = await canvas.handleMusicSubmit(post("/internal/music/submit", planSubmitBody), "*", "test");
canvas.consumeProof = proofSuccess;
canvas.rateLimit = rateLimitSuccess;
const submittedReplay = await submittedReplayResponse.json();
check(
  "music-plan submission retries return the original durable queue result without another proof, rate-limit check, or write",
  submittedReplayResponse.status === 200
    && submittedReplay.replayed === true
    && submittedReplay.song?.id === submittedBody.song?.id
    && JSON.stringify(await storage.get("music")) === musicBeforeSubmitReplay
    && JSON.stringify(await storage.get(`musicplan:${planId}`)) === planBeforeSubmitReplay,
  JSON.stringify(submittedReplay)
);

const queueStorage = new MemoryStorage();
const queueCanvas = new GrokPlaceCanvas({ storage: queueStorage }, {});
queueCanvas.rateLimit = async () => ({ ok: true });
queueCanvas.consumeProof = async () => ({ ok: true, challengeId: "test", nonce: 0, digest: "0".repeat(64) });
queueCanvas.requireAgentCapability = async () => ({ ok: true });
queueCanvas.readAgent = async (_key, name) => ({ name, placements: 1 });
const submitDirect = (agent, clientRequestId, title, note) => queueCanvas.handleMusicSubmit(post("/internal/music/submit", {
  agent,
  clientRequestId,
  title,
  composition: { bpm: 104, waveform: "sine", notes: [{ note, at: 0, duration: 2, velocity: 0.7 }] },
  license: "CC0-1.0",
  original: true,
  nonInfringing: true,
  challengeId: "test",
  nonce: 0,
}), "*", "test");

const [sameCompositionFirst, sameCompositionSecond] = await Promise.all([
  submitDirect("dedup-first", "music-dedup-first-001", "Shared composition", "A4"),
  submitDirect("dedup-second", "music-dedup-second-001", "Shared composition", "A4"),
]);
const sameCompositionResults = await Promise.all([sameCompositionFirst, sameCompositionSecond].map(async (response) => ({ status: response.status, body: await response.json() })));
const queueAfterDedup = await queueStorage.get("music");
check(
  "simultaneous deterministic-composition submissions have one durable queue winner",
  sameCompositionResults.filter((result) => result.status === 200).length === 1
    && sameCompositionResults.filter((result) => result.status === 409 && result.body.error === "duplicate").length === 1
    && [queueAfterDedup?.now, ...(queueAfterDedup?.queue || [])].filter(Boolean).length === 1,
  JSON.stringify(sameCompositionResults)
);

const [distinctFirst, distinctSecond] = await Promise.all([
  submitDirect("queue-first", "music-queue-first-001", "Queue first", "B4"),
  submitDirect("queue-second", "music-queue-second-001", "Queue second", "C5"),
]);
const distinctResults = await Promise.all([distinctFirst, distinctSecond].map(async (response) => ({ status: response.status, body: await response.json() })));
const queueAfterDistinct = await queueStorage.get("music");
check(
  "concurrent distinct submissions both persist within the bounded queue",
  distinctResults.every((result) => result.status === 200)
    && [queueAfterDistinct?.now, ...(queueAfterDistinct?.queue || [])].filter(Boolean).length === 3
    && (queueAfterDistinct?.queue || []).length <= 24
    && queueStorage.transactionCount >= 4,
  JSON.stringify(distinctResults)
);

const [sameRequestFirst, sameRequestSecond] = await Promise.all([
  submitDirect("queue-retry", "music-queue-retry-001", "Queue retry", "E5"),
  submitDirect("queue-retry", "music-queue-retry-001", "Queue retry", "E5"),
]);
const sameRequestResults = await Promise.all([sameRequestFirst, sameRequestSecond].map(async (response) => ({ status: response.status, body: await response.json() })));
const queueAfterSameRequest = await queueStorage.get("music");
check(
  "simultaneous retries of one client request queue exactly one composition",
  sameRequestResults.every((result) => result.status === 200)
    && sameRequestResults.filter((result) => result.body.replayed === true).length === 1
    && [queueAfterSameRequest?.now, ...(queueAfterSameRequest?.queue || [])].filter(Boolean).length === 4,
  JSON.stringify(sameRequestResults)
);

const submitReplayKey = "music:submit:requests:replay-cleanup-agent";
const submitReplaySeed = Array.from({ length: 33 }, (_, index) => ({
  version: 1,
  clientRequestId: `retained-submit-${String(index).padStart(2, "0")}`,
  action: "submit",
  requestHash: "b".repeat(64),
  createdAt: Date.now(),
  status: 200,
  result: { ok: true },
}));
submitReplaySeed.push({ ...submitReplaySeed[0], clientRequestId: "expired-submit-00", createdAt: Date.now() - 25 * 60 * 60 * 1_000 });
await queueStorage.put(submitReplayKey, submitReplaySeed);
const submitReplayCleanup = await submitDirect("replay-cleanup-agent", "music-submit-cleanup-001", "Replay cleanup", "D5");
const retainedSubmitReplays = await queueStorage.get(submitReplayKey);
check(
  "music submit replay records stay bounded and discard expired entries",
  submitReplayCleanup.status === 200
    && Array.isArray(retainedSubmitReplays)
    && retainedSubmitReplays.length === 32
    && retainedSubmitReplays.every((record) => record.clientRequestId !== "expired-submit-00")
    && retainedSubmitReplays.some((record) => record.clientRequestId === "music-submit-cleanup-001"),
  JSON.stringify(retainedSubmitReplays)
);

const fullQueueSong = (id, agent, note) => ({
  id,
  title: id,
  submittedBy: agent,
  votes: 1,
  addedAt: 1,
  queueOrder: Number(id.slice(1)) || 0,
  composition: { bpm: 104, waveform: "sine", notes: [{ note, at: 0, duration: 2, velocity: 0.7 }], durationMs: 289 },
  license: "CC0-1.0",
  originalNonInfringingAttested: true,
});
await queueStorage.put("music", {
  now: fullQueueSong("n0", "current-agent", "C4"),
  queue: Array.from({ length: 24 }, (_, index) => fullQueueSong(`q${index}`, `full-agent-${index}`, "D4")),
  version: 9,
  nextQueueOrder: 25,
});
const fullQueueResponse = await submitDirect("queue-cap-agent", "music-queue-cap-001", "Queue cap", "E4");
const fullQueueBody = await fullQueueResponse.json();
check("music submission enforces the total queue cap inside its transaction", fullQueueResponse.status === 400 && fullQueueBody.error === "queue_full", JSON.stringify(fullQueueBody));

await storage.delete("mscd:plan-owner");
const secondSong = await canvas.handleMusicSubmit(post("/internal/music/submit", {
  agent: "plan-owner",
  clientRequestId: "music-direct-second-001",
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
  clientRequestId: "music-direct-capped-001",
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
const storedPromotion = await storage.get("music");
const storedPromotionAlarm = await storage.get("musicAlarmTarget");
check(
  "fair promotion avoids an immediate contributor repeat and persists its exact alarm target",
  promoted.now?.submittedBy === "agent-b"
    && promoted.queue?.[0]?.submittedBy === "agent-a"
    && storedPromotion?.now?.id === promoted.now?.id
    && storedPromotionAlarm?.compositionId === promoted.now?.id
    && storedPromotionAlarm?.endsAt === promoted.now?.endsAt
    && (await storage.getAlarm()) === promoted.now?.endsAt,
  JSON.stringify(promoted)
);

const shortStartedAt = Date.now();
const shortSong = {
  id: "short-song",
  title: "Short",
  submittedBy: "short-agent",
  votes: 1,
  addedAt: shortStartedAt,
  startedAt: shortStartedAt,
  endsAt: shortStartedAt + 1_000,
  advanceToken: "a".repeat(32),
  composition: { bpm: 120, waveform: "sine", notes: [{ note: "C4", at: 0, duration: 8, velocity: 0.7 }], durationMs: 1_000 },
  license: "CC0-1.0",
  originalNonInfringingAttested: true,
};
const shortAdvanceStorage = new MemoryStorage({ music: { now: shortSong, queue: [], version: 1 } });
const shortAdvanceCanvas = new GrokPlaceCanvas({ storage: shortAdvanceStorage }, {});
shortAdvanceCanvas.rateLimit = async () => ({ ok: true });
const shortAdvanceResponse = await shortAdvanceCanvas.handleMusicAdvance(post("/internal/music/advance", { compositionId: shortSong.id, advanceToken: shortSong.advanceToken }), "*", "test");
const shortAdvance = await shortAdvanceResponse.json();
check(
  "public advance cannot skip a short composition before its deterministic end",
  shortAdvanceResponse.status === 429
    && shortAdvance.error === "too_early"
    && shortAdvance.opensAt === shortSong.endsAt,
  JSON.stringify(shortAdvance)
);

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
