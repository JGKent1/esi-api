#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# ESI — one-time push of esi-api to GitHub (JGKent1/esi-api)
#
# Before running:
#   1. Create the EMPTY private repo in your browser (no README, no .gitignore):
#      https://github.com/new  →  name: esi-api  →  Private  →  Create
#
# Then, in Terminal:
#   cd "/Users/gk/Documents/Claude/Projects/EXCEED_Student/05_ESI_System/03_Application/esi-api"
#   bash push_to_github.sh
#
# The .gitignore already excludes node_modules and .env, so only source ships.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f server.js ] || [ ! -f Procfile ]; then
  echo "Run this from inside the esi-api folder — server.js not found here." >&2
  exit 1
fi

git init -b main 2>/dev/null || git init 2>/dev/null || true
git add -A
git commit -m "esi-api v1.0 baseline — 38-item instrument, deterministic engine, 48 tests green" \
  || echo "(nothing new to commit — continuing)"

git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/JGKent1/esi-api.git"
git push -u origin main

echo
echo "✓ Pushed. Two follow-ups, both in the browser:"
echo "  1. Railway → make sure its GitHub connection can see JGKent1/esi-api"
echo "     (github.com/settings/installations → Railway → Repository access)"
echo "  2. Optional, for future Claude sessions: add esi-api to the Claude"
echo "     GitHub app's repository access the same way."
