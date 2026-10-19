#!/usr/bin/env bash
# Sets the staging Worker secret ANALYTICS_TOKEN from $ANALYTICS_TOKEN (stdin,
# never argv or output). Skips when it is empty. Run from apps/server.
set -euo pipefail
if [[ -z "${ANALYTICS_TOKEN:-}" ]]; then
  echo "ANALYTICS_TOKEN is empty; skipping"
  exit 0
fi
printf %s "$ANALYTICS_TOKEN" | pnpm exec wrangler secret put ANALYTICS_TOKEN -c wrangler.staging.jsonc --env staging >/dev/null
echo "ANALYTICS_TOKEN set on the staging Worker"
