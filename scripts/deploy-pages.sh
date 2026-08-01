#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/sync-docs.mjs
echo "docs/ ready. Commit and push main to publish GitHub Pages (Settings → Pages → /docs)."
