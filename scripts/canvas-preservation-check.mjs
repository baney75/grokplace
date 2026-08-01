#!/usr/bin/env node
/** Verify a deploy did not shrink or alter pre-existing painted canvas cells. */
import { readFileSync } from "node:fs";

function value(flag) {
  const i = process.argv.indexOf(flag);
  return i < 0 ? null : process.argv[i + 1] || null;
}

const beforeFile = value("--before");
const afterFile = value("--after");
if (!beforeFile || !afterFile) {
  console.error("Usage: node scripts/canvas-preservation-check.mjs --before before.json --after after.json");
  process.exit(2);
}

function canvas(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data?.ok || !Number.isInteger(data.size) || typeof data.board !== "string") throw new Error(`${file}: not a canvas response`);
  const board = Buffer.from(data.board, "base64");
  if (board.length !== data.size * data.size) throw new Error(`${file}: invalid board length`);
  return { size: data.size, board };
}

try {
  const before = canvas(beforeFile);
  const after = canvas(afterFile);
  if (after.size < before.size) throw new Error(`canvas shrank from ${before.size} to ${after.size}`);
  let existing = 0;
  let altered = 0;
  for (let y = 0; y < before.size; y++) {
    for (let x = 0; x < before.size; x++) {
      const beforeValue = before.board[y * before.size + x];
      if (beforeValue === 0) continue;
      existing++;
      if (after.board[y * after.size + x] !== beforeValue) altered++;
    }
  }
  if (altered) throw new Error(`${altered}/${existing} pre-existing painted cells changed value`);
  console.log(`PASS canvas preserved exactly: size ${before.size}→${after.size}; ${existing} prior painted cells retain their values`);
} catch (error) {
  console.error(`FAIL canvas preservation: ${error.message || error}`);
  process.exitCode = 1;
}
