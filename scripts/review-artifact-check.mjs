#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function required(name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

try {
  const file = required("--file");
  const artifact = required("--artifact");
  const head = required("--head").toLowerCase();
  const authorAgent = required("--author-agent").toLowerCase();
  const data = JSON.parse(readFileSync(file, "utf8"));
  const review = data?.review;
  if (data?.ok !== true || !review) throw new Error("artifact response is not ok");
  if (!/^rv_[a-f0-9]{32}$/.test(artifact) || review.id !== artifact) throw new Error("artifact id mismatch");
  if (!/^[a-f0-9]{40}$/.test(head) || review.headSha !== head) throw new Error("artifact head mismatch");
  if (review.verdict !== "SHIP") throw new Error("artifact verdict is not SHIP");
  if (typeof review.reviewerAgent !== "string" || review.reviewerAgent.toLowerCase() === authorAgent) throw new Error("reviewer must be a different authenticated agent");
  console.log(`Verified immutable review artifact ${artifact}.`);
} catch (error) {
  console.error(`Review artifact rejected: ${error.message || error}`);
  process.exit(1);
}
