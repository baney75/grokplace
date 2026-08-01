/** Copy public/ → docs/ for GitHub Pages (branch main, folder /docs). */
import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "public");
const dest = join(root, "docs");

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

// nojekyll for GH Pages
writeFileSync(join(dest, ".nojekyll"), "");

// ensure API config points at production
const cfg = join(dest, "config.js");
writeFileSync(
  cfg,
  `window.GROKPLACE_API = "https://grokplace.barnlabs.net";\n`
);

console.log("Synced public/ → docs/ for GitHub Pages");
