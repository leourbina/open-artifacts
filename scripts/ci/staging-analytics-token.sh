#!/usr/bin/env bash
# Sets the staging Worker secret ANALYTICS_TOKEN from $ANALYTICS_TOKEN (stdin,
# never argv or output). Run from apps/server. Records analytics=ok|skipped|failed
# in $GITHUB_OUTPUT and exits 0 even on failure, so smoke still runs; the smoke
# job's last step (`outcome` mode) then fails the run on `failed`.
# Usage: staging-analytics-token.sh [outcome]
set -euo pipefail
out="${GITHUB_OUTPUT:-/dev/null}"
if [[ "${1:-}" == outcome ]]; then
  if [[ "${ANALYTICS_OUTCOME:-}" == failed ]]; then
    echo "ANALYTICS_TOKEN put failed in the deploy job; smoke ran, failing the run"
    exit 1
  fi
  echo "ANALYTICS_TOKEN put: ${ANALYTICS_OUTCOME:-unknown}"
  exit 0
fi
if [[ -z "${ANALYTICS_TOKEN:-}" ]]; then
  echo "ANALYTICS_TOKEN is empty; skipping"
  echo "analytics=skipped" >>"$out"
  exit 0
fi
if printf %s "$ANALYTICS_TOKEN" | pnpm exec wrangler secret put ANALYTICS_TOKEN -c wrangler.staging.jsonc --env staging >/dev/null 2>&1; then
  echo "ANALYTICS_TOKEN set on the staging Worker"
  echo "analytics=ok" >>"$out"
else
  echo "::error::ANALYTICS_TOKEN put failed on the staging Worker; smoke still runs, then the run fails"
  echo "analytics=failed" >>"$out"
fi
