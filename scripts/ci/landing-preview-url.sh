#!/usr/bin/env bash
# Deploy a landing preview and write url=<preview url> to $GITHUB_OUTPUT. Run from apps/landing.
# Usage: landing-preview-url.sh <pr-number>
set -euo pipefail
pr="${1:?pr number required}"
pnpm exec wrangler preview --name "pr-$pr" --json > preview.raw
# wrangler may print non-JSON lines before the JSON; start at the first line beginning with {
sed -n '/^{/,$p' preview.raw > preview.json
if ! url=$(jq -er '.preview.urls[0]' preview.json); then
  echo "::error::could not parse preview URL; raw wrangler stdout and extracted JSON follow"
  cat preview.raw
  echo "--- preview.json ---"
  cat preview.json
  exit 1
fi
echo "url=$url" >> "$GITHUB_OUTPUT"
