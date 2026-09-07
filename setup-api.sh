#!/usr/bin/env bash
# ✂️ Resume Tailor — one-script API setup.
#
#   ./setup-api.sh
#
# Puts your Anthropic API key (and optional access code) into the Cloudflare
# Worker and deploys it. Keys never touch the website — they live only in the
# Worker. Run it again any time to rotate a key.
set -euo pipefail
cd "$(dirname "$0")/worker"

bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true); off=$(tput sgr0 2>/dev/null || true)
echo "${bold}✂️ Resume Tailor — API setup${off}"
echo "${dim}Everything below is stored as a Cloudflare secret, never in the site.${off}"
echo

command -v npx >/dev/null 2>&1 || { echo "This needs Node.js — install it from https://nodejs.org and re-run."; exit 1; }

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "First, log in to Cloudflare (a browser window will open)…"
  npx wrangler login
fi

read -rsp "Anthropic API key (sk-ant-…, blank = keep current): " KEY; echo
if [ -n "${KEY}" ]; then
  printf '%s' "$KEY" | npx wrangler secret put ANTHROPIC_API_KEY
  echo "  ✓ Claude key set"
fi

read -rsp "Access code she types once (blank = keep current / none): " CODE; echo
if [ -n "${CODE}" ]; then
  printf '%s' "$CODE" | npx wrangler secret put ACCESS_CODE
  echo "  ✓ Access code set"
fi

echo
echo "Deploying the Worker…"
npx wrangler deploy

echo
echo "${bold}Health check:${off}"
curl -s "https://resume-tailor-api.streamedmusics.workers.dev/api/health" || true
echo
echo
echo "${bold}Done.${off} Site: https://vlues.github.io/resume-tailor/"
