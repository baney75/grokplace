#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const cwd = root.pathname;
const evidence = mkdtempSync(join(tmpdir(), "grokplace-release-evidence-"));
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function bytes(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name);
    return total + (entry.isDirectory() ? bytes(child) : statSync(child).size);
  }, 0);
}

function run(label, args, outdir) {
  try {
    const output = execFileSync(process.execPath, ["./node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--outdir", outdir, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const total = bytes(outdir);
    const upload = output.match(/Total Upload:.*$/m)?.[0] || "";
    check(`${label} Wrangler dry-run bundles without uploading`, total > 0 && Boolean(upload) && /--dry-run: exiting now/.test(output), `bundleBytes=${total}; ${upload}`);
    console.log(`EVIDENCE ${label}: ${upload}; bundleDirBytes=${total}; dry-run only`);
  } catch (error) {
    check(`${label} Wrangler dry-run bundles without uploading`, false, String(error.stderr || error.message || error));
  }
}

try {
  const before = join(evidence, "before.json");
  const after = join(evidence, "after.json");
  writeFileSync(before, JSON.stringify({ ok: true, size: 2, board: Buffer.from([1, 0, 0, 2]).toString("base64") }));
  writeFileSync(after, JSON.stringify({ ok: true, size: 4, board: Buffer.from([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64") }));
  const output = execFileSync(process.execPath, ["scripts/canvas-preservation-check.mjs", "--before", before, "--after", after], { cwd, encoding: "utf8" });
  check("canvas preservation evidence accepts a grow that retains every old painted cell", /PASS canvas preserved exactly/.test(output), output.trim());

  run("production", [], join(evidence, "production"));
  run("maintenance", ["--config", "ops/wrangler.maintenance.toml"], join(evidence, "maintenance"));
} finally {
  rmSync(evidence, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
