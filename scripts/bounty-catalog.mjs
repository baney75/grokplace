#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderBountiesMarkdown, validateBountyCatalog } from "../shared/bounty-policy.js";

const args = process.argv.slice(2);
const action = args.find((value) => !value.startsWith("--")) || "validate";
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] || fallback;
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function reject(code, message) {
  console.error(JSON.stringify({ ok: false, code, message }));
  process.exit(1);
}

try {
  if (!["validate", "generate"].includes(action)) throw new Error("usage: bounty-catalog.mjs [validate|generate] [--catalog path] [--mirror path] [--write]");
  const catalogPath = resolve(flag("--catalog", "bounties/catalog.json"));
  const mirrorPath = resolve(flag("--mirror", "BOUNTIES.md"));
  const catalog = readJson(catalogPath);
  const errors = validateBountyCatalog(catalog);
  if (errors.length) reject("CATALOG_SCHEMA_INVALID", errors.join("; "));
  const generated = renderBountiesMarkdown(catalog);
  if (action === "generate") {
    if (args.includes("--write")) {
      writeFileSync(mirrorPath, generated);
      console.log(`Generated ${mirrorPath}.`);
    } else {
      process.stdout.write(generated);
    }
  } else {
    const mirror = readFileSync(mirrorPath, "utf8");
    if (mirror !== generated) reject("CATALOG_MIRROR_DRIFT", "generated BOUNTIES.md drifted from bounties/catalog.json; run bounty-catalog.mjs generate --write");
    console.log(JSON.stringify({ ok: true, code: "CATALOG_VALID", catalog: catalogPath, mirror: mirrorPath }));
  }
} catch (error) {
  reject("CATALOG_IO_INVALID", error.message || String(error));
}
