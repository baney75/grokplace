#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function required(name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const githubLogin = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

try {
  const mode = required("--mode");
  if (mode !== "product-owner" && mode !== "maintainer") {
    throw new Error("--mode must be product-owner or maintainer");
  }
  const file = required("--file");
  const artifact = required("--artifact");
  const head = required("--head").toLowerCase();
  const implementerAgent = required("--implementer-agent").toLowerCase();
  const requireVerifiedMaintainer = args.includes("--require-verified-maintainer");
  const hasAuthorGithub = args.includes("--author-github");
  if (mode === "maintainer" && !requireVerifiedMaintainer) {
    throw new Error("maintainer mode requires --require-verified-maintainer");
  }
  if (mode === "maintainer" && !hasAuthorGithub) {
    throw new Error("maintainer mode requires --author-github");
  }
  if (mode === "product-owner" && (requireVerifiedMaintainer || hasAuthorGithub)) {
    throw new Error("verified-maintainer flags are only valid in maintainer mode");
  }
  const authorGithub = mode === "maintainer" ? required("--author-github") : "";
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(implementerAgent)) throw new Error("--implementer-agent is invalid");
  if (mode === "maintainer" && !githubLogin.test(authorGithub)) throw new Error("--author-github is invalid");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const review = data?.review;
  if (data?.ok !== true || !review) throw new Error("artifact response is not ok");
  if (!/^rv_[a-f0-9]{32}$/.test(artifact) || review.id !== artifact) throw new Error("artifact id mismatch");
  if (!/^[a-f0-9]{40}$/.test(head) || review.headSha !== head) throw new Error("artifact head mismatch");
  if (review.verdict !== "SHIP") throw new Error("artifact verdict is not SHIP");
  if (typeof review.reviewerAgent !== "string" || !/^[a-zA-Z0-9_-]{2,32}$/.test(review.reviewerAgent) || review.reviewerAgent.toLowerCase() === implementerAgent) {
    throw new Error("reviewer must be a different authenticated agent");
  }
  if (mode === "maintainer") {
    if (review.reviewerTrust !== "verified_maintainer") throw new Error("maintenance review requires a verified maintainer reviewer");
    if (typeof review.reviewerGithub !== "string" || !githubLogin.test(review.reviewerGithub) || !Number.isSafeInteger(review.reviewerGithubId) || review.reviewerGithubId < 1) {
      throw new Error("verified reviewer GitHub identity is missing or invalid");
    }
    if (review.reviewerGithub.toLowerCase() === authorGithub.toLowerCase()) throw new Error("reviewer GitHub principal must differ from the PR author");
  }
  console.log(`Verified immutable ${mode} review artifact ${artifact}.`);
} catch (error) {
  console.error(`Review artifact rejected: ${error.message || error}`);
  process.exit(1);
}
