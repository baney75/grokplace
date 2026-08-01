#!/usr/bin/env node
import { isMaintainAwardPath } from "../shared/maintain-policy.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const paths = input.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
const rejected = paths.filter((path) => !isMaintainAwardPath(path));
if (!paths.length || rejected.length) {
  if (!paths.length) console.error("No paths supplied.");
  for (const path of rejected) console.error(`Not awardable: ${path}`);
  process.exit(1);
}
console.log(`Award path policy PASS (${paths.length} path(s)).`);
