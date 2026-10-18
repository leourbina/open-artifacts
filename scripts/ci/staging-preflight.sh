#!/usr/bin/env bash
# Fail if a required Worker secret is missing. Run from apps/server.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pnpm exec wrangler secret list -c wrangler.staging.jsonc --env staging --format json | node "$root/scripts/ops/check-staging-secrets.ts"
