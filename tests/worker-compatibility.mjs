#!/usr/bin/env node
import { GrokPlaceCanvas } from "../worker/index.js";

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

const now = Date.now();
const cooldownAt = now + 60_000;
const turnStorage = new MemoryStorage({
  "turn:legacy-agent": { nextTurnAt: cooldownAt },
});
const turnCanvas = new GrokPlaceCanvas({ storage: turnStorage }, {});
turnCanvas.rateLimit = async () => ({ ok: true });
turnCanvas.consumeProof = async () => ({ ok: true });
turnCanvas.requireAgentCapability = async () => ({ ok: true });

const turnResponse = await turnCanvas.handlePlace(
  new Request("https://test/internal/place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "legacy-agent", goal: "small safe tile", x: 0, y: 0, color: 0 }),
  }),
  8,
  30_000,
  "*",
  "test"
);
const turnBody = await turnResponse.json();
check(
  "legacy sparse turn state cannot block unlimited placement",
  turnResponse.status === 200
    && turnBody.ok === true
    && turnBody.placedCount === 1
    && turnBody.placement?.mode === "unlimited"
    && turnBody.placement?.maxBatchTiles === 20
    && (await turnStorage.get("board")) !== undefined
    && JSON.stringify(await turnStorage.get("turn:legacy-agent")) === JSON.stringify({ nextTurnAt: cooldownAt }),
  JSON.stringify(turnBody)
);

const placementLimitCanvas = new GrokPlaceCanvas({ storage: new MemoryStorage() }, {});
const firstTileAllowance = await placementLimitCanvas.rateLimit("place", "rate-test-ip", 20, 60_000, 20);
const overflowTileAllowance = await placementLimitCanvas.rateLimit("place", "rate-test-ip", 20, 60_000, 1);
check(
  "unlimited placement remains bounded by a moderation-compatible per-IP tile rate",
  firstTileAllowance.ok === true && overflowTileAllowance.ok === false && overflowTileAllowance.retryAfterMs > 0,
  JSON.stringify({ firstTileAllowance, overflowTileAllowance })
);

const legacyMeta = { version: 23, totalPlacements: 91, uniqueAgents: 12, lastPlaceAt: now - 500, createdAt: now - 60_000 };
const metaCanvas = new GrokPlaceCanvas({ storage: new MemoryStorage({ meta: legacyMeta }) }, {});
const restoredMeta = await metaCanvas.readCanvasMeta();
check(
  "legacy canvas metadata without vote counters preserves existing history",
  restoredMeta.version === 23
    && restoredMeta.totalPlacements === 91
    && restoredMeta.uniqueAgents === 12
    && restoredMeta.lastPlaceAt === legacyMeta.lastPlaceAt
    && restoredMeta.totalVotes === 0,
  JSON.stringify(restoredMeta)
);

function song(id, addedAt) {
  return {
    id,
    title: `${id} melody`,
    submittedBy: "legacy-agent",
    votes: 1,
    voters: ["legacy-agent"],
    addedAt,
    composition: {
      bpm: 120,
      waveform: "sine",
      notes: [{ note: "C4", at: 0, duration: 4, velocity: 0.5 }],
      durationMs: 500,
    },
    license: "CC0-1.0",
    originalNonInfringingAttested: true,
  };
}

const current = {
  ...song("current", now - 1_000),
  startedAt: now - 1_000,
  endsAt: now + 60_000,
  advanceToken: "a".repeat(32),
};
const queued = song("queued", now);
const legacyMusic = { now: current, queue: [queued] };
const musicStorage = new MemoryStorage({
  music: legacyMusic,
  musicAlarmTarget: { compositionId: "current", endsAt: current.endsAt },
});
musicStorage.alarmAt = current.endsAt;
const musicCanvas = new GrokPlaceCanvas({ storage: musicStorage }, {});
const music = await musicCanvas.getMusic();
check(
  "legacy music without a version keeps the current song and queue without a skip or overwrite",
  music.version === 0
    && music.now?.id === "current"
    && music.queue.length === 1
    && music.queue[0]?.id === "queued"
    && (await musicStorage.get("music")) === legacyMusic,
  JSON.stringify(music)
);

const partlyInvalidMusic = { now: current, queue: [queued, { id: "malformed" }], version: 3 };
const partialMusicCanvas = new GrokPlaceCanvas({ storage: new MemoryStorage({ music: partlyInvalidMusic }) }, {});
const partialMusic = await partialMusicCanvas.getMusic();
check(
  "a malformed legacy composition is removed without discarding valid music",
  partialMusic.now?.id === "current"
    && partialMusic.queue.length === 1
    && partialMusic.queue[0]?.id === "queued"
    && (await partialMusicCanvas.state.storage.get("musicQuarantine"))?.dropped === 1,
  JSON.stringify({ partialMusic, quarantine: await partialMusicCanvas.state.storage.get("musicQuarantine") })
);

const unknownStatusCanvas = new GrokPlaceCanvas({ storage: new MemoryStorage() }, {});
const unknownStatus = await unknownStatusCanvas.handleStatus(new URL("https://test/internal/status?agent=unknown-agent"), 60_000, "*");
const unknownStatusBody = await unknownStatus.json();
check(
  "status leaves absent agent memory absent instead of fabricating timestamps",
  unknownStatusBody.claimed === false && unknownStatusBody.memory === null,
  JSON.stringify(unknownStatusBody)
);

const githubCanvas = new GrokPlaceCanvas({ storage: new MemoryStorage() }, {});
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({
    login: "legacy-agent",
    id: 5,
    html_url: "https://github.com/legacy-agent",
    created_at: "2020-01-01T00:00:00Z",
    public_repos: 1,
    followers: 0,
    bio: null,
    blog: null,
    type: "User",
  }));
  const invalidProfile = await githubCanvas.verifyGithubProfile("legacy-agent");
  check(
    "GitHub verification rejects a missing exact API field before applying trust heuristics",
    !invalidProfile.ok && invalidProfile.reason === "github_invalid_profile",
    JSON.stringify(invalidProfile)
  );
} finally {
  globalThis.fetch = originalFetch;
}

if (failed) process.exit(1);
