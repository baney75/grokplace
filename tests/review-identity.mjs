#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GrokPlaceCanvas } from "../worker/index.js";

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "grokplace-review-identity-"));
const artifactId = "rv_11111111111111111111111111111111";
const headSha = "0123456789abcdef0123456789abcdef01234567";
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function runCli(name, review, extraArgs, expected) {
  const file = join(temp, `${name.replace(/[^a-z0-9]+/gi, "-")}.json`);
  writeFileSync(file, JSON.stringify({ ok: true, review }));
  const out = spawnSync(process.execPath, [
    "scripts/review-artifact-check.mjs",
    "--mode", extraArgs.mode,
    "--file", file,
    "--artifact", artifactId,
    "--head", headSha,
    "--implementer-agent", "author-agent",
    ...extraArgs.args,
  ], { cwd: root, encoding: "utf8" });
  check(name, out.status === expected, `${out.stdout}${out.stderr}`.trim());
}

const verifiedReview = {
  id: artifactId,
  reviewerAgent: "critic-agent",
  reviewerTrust: "verified_maintainer",
  reviewerGithub: "distinct-reviewer",
  reviewerGithubId: 12345,
  headSha,
  verdict: "SHIP",
};
const productOwnerArgs = { mode: "product-owner", args: [] };
const maintainerArgs = { mode: "maintainer", args: ["--author-github", "pr-author", "--require-verified-maintainer"] };

runCli("active distinct maintainer passes", verifiedReview, maintainerArgs, 0);
runCli("same GitHub principal fails case-insensitively", { ...verifiedReview, reviewerGithub: "PR-AUTHOR" }, maintainerArgs, 1);
runCli("claimed-only reviewer fails maintenance mode", { ...verifiedReview, reviewerTrust: "claimed_agent_only", reviewerGithub: undefined, reviewerGithubId: undefined }, maintainerArgs, 1);
runCli("missing verified GitHub identity fails maintenance mode", { ...verifiedReview, reviewerGithubId: undefined }, maintainerArgs, 1);
runCli("maintainer mode requires explicit verified flag", verifiedReview, { mode: "maintainer", args: ["--author-github", "pr-author"] }, 1);
runCli("product-owner mode rejects maintainer flags", verifiedReview, { mode: "product-owner", args: maintainerArgs.args }, 1);
runCli("claimed distinct agent passes product-owner mode", { ...verifiedReview, reviewerTrust: "claimed_agent_only", reviewerGithub: undefined, reviewerGithubId: undefined }, productOwnerArgs, 0);
runCli("implementer cannot self-review product-owner mode", { ...verifiedReview, reviewerAgent: "AUTHOR-AGENT" }, productOwnerArgs, 1);
runCli("exact head binding remains enforced", { ...verifiedReview, headSha: "f".repeat(40) }, maintainerArgs, 1);
runCli("SHIP verdict remains enforced", { ...verifiedReview, verdict: "REWORK" }, maintainerArgs, 1);

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  async get(key) { return this.values.get(key); }
  async put(key, value) {
    if (key && typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
    else this.values.set(key, value);
  }
  async delete(key) { this.values.delete(key); }
}

async function attest(storageValues, agent = "critic-agent") {
  const storage = new MemoryStorage(storageValues);
  const canvas = new GrokPlaceCanvas({ storage }, {});
  canvas.consumeProof = async () => ({ ok: true });
  canvas.requireAgentCapability = async () => ({ ok: true });
  const request = new Request("https://test/internal/reviews/attest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent,
      headSha,
      verdict: "SHIP",
      findings: "No blocking findings in the bounded review.",
      residualRisk: "A later dependency change could alter behavior.",
    }),
  });
  const response = await canvas.handleReviewAttest(request, "*", "test-ip");
  const data = await response.json();
  const stored = data.review?.id ? await storage.get(`review:${data.review.id}`) : null;
  return { response, data, stored, canvas };
}

const verifiedAttestation = await attest({
  maintainers: [{ agent: "critic-agent", github: "distinct-reviewer", githubId: 12345, profile: { id: 12345 }, status: "active" }],
});
check(
  "active maintainer identity is immutable and public",
  verifiedAttestation.response.status === 201 &&
    verifiedAttestation.stored?.reviewerTrust === "verified_maintainer" &&
    verifiedAttestation.stored?.reviewerGithub === "distinct-reviewer" &&
    verifiedAttestation.stored?.reviewerGithubId === 12345 &&
    verifiedAttestation.data.review?.reviewerGithub === "distinct-reviewer",
  JSON.stringify(verifiedAttestation.data)
);

const claimedAttestation = await attest({ maintainers: [] });
check(
  "claimed agent artifact stays usable but unverified",
  claimedAttestation.response.status === 201 &&
    claimedAttestation.stored?.reviewerTrust === "claimed_agent_only" &&
    claimedAttestation.data.review?.reviewerTrust === "claimed_agent_only" &&
    !("reviewerGithub" in claimedAttestation.data.review) &&
    !("reviewerGithubId" in claimedAttestation.data.review),
  JSON.stringify(claimedAttestation.data)
);

const reviewStorage = new MemoryStorage();
const reviewCanvas = new GrokPlaceCanvas({ storage: reviewStorage }, {});
reviewCanvas.consumeProof = async () => ({ ok: true });
const reviewClaimResponse = await reviewCanvas.handleReviewClaim(
  new Request("https://test/internal/reviews/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: "test", nonce: 0 }),
  }),
  "*",
  "review-ip"
);
const reviewClaim = await reviewClaimResponse.json();
const reviewAgent = typeof reviewClaim.agent === "string" ? reviewClaim.agent : "";
const reviewCapability = typeof reviewClaim.reviewCapability === "string" ? reviewClaim.reviewCapability : "";
const reviewRecord = reviewAgent ? await reviewStorage.get(`reviewauth:${reviewAgent.toLowerCase()}`) : null;
check(
  "review claim issues only a short-lived review credential",
  reviewClaimResponse.status === 201 &&
    /^reviewer_[a-f0-9]{16}$/.test(reviewAgent) &&
    /^gp_r_[a-f0-9]{64}$/.test(reviewCapability) &&
    reviewRecord?.agent === reviewAgent &&
    !await reviewStorage.get(`auth:${reviewAgent.toLowerCase()}`) &&
    !await reviewStorage.get(`agent:${reviewAgent.toLowerCase()}`),
  JSON.stringify(reviewClaim)
);

const reviewAttestResponse = await reviewCanvas.handleReviewAttest(
  new Request("https://test/internal/reviews/attest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Review ${reviewCapability}` },
    body: JSON.stringify({
      agent: reviewAgent,
      headSha,
      verdict: "SHIP",
      findings: "No blocking findings in the bounded review.",
      residualRisk: "A later dependency change could alter behavior.",
      challengeId: "test",
      nonce: 0,
    }),
  }),
  "*",
  "review-ip"
);
check(
  "review-only credential can attest but remains claimed-only",
  reviewAttestResponse.status === 201 && (await reviewAttestResponse.clone().json()).review?.reviewerAgent === reviewAgent && (await reviewAttestResponse.clone().json()).review?.reviewerTrust === "claimed_agent_only"
);

const reviewPlaceResponse = await reviewCanvas.handlePlace(
  new Request("https://test/internal/place", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Review ${reviewCapability}` },
    body: JSON.stringify({ agent: reviewAgent, goal: "test tile", x: 0, y: 0, color: 0, challengeId: "test", nonce: 0 }),
  }),
  2,
  30_000,
  "*",
  "review-ip"
);
check(
  "review-only credential cannot place tiles",
  reviewPlaceResponse.status === 401 && (await reviewPlaceResponse.json()).error === "agent_claim_required"
);

await reviewStorage.put(`reviewauth:${reviewAgent.toLowerCase()}`, { ...reviewRecord, expiresAt: 0 });
const expiredReview = await reviewCanvas.requireReviewCapability(
  new Request("https://test/internal/reviews/attest", { headers: { Authorization: `Review ${reviewCapability}` } }),
  reviewAgent
);
check("expired review capability is deleted and rejected", !expiredReview.ok && expiredReview.error === "review_capability_expired" && !await reviewStorage.get(`reviewauth:${reviewAgent.toLowerCase()}`));

const capability = `gp_a_${"a".repeat(64)}`;
const reviewCapabilityLeak = `gp_r_${"b".repeat(64)}`;
const legacyPublic = claimedAttestation.canvas.publicReview({
  id: artifactId,
  reviewerAgent: "critic-agent",
  headSha,
  verdict: "SHIP",
  findings: `legacy ${capability} ${reviewCapabilityLeak}`,
  residualRisk: "Legacy review identity has limited assurance.",
  createdAt: 1,
});
check(
  "legacy claimed artifact is token-safe",
  legacyPublic?.reviewerTrust === "claimed_agent_only" && !/gp_[ar]_[a-f0-9]{64}/i.test(JSON.stringify(legacyPublic)),
  JSON.stringify(legacyPublic)
);

rmSync(temp, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
