#!/usr/bin/env bash
# Delete Worker secrets that are also staging vars (they break `wrangler deploy`). Run from apps/server.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
names=$(pnpm exec wrangler secret list -c wrangler.staging.jsonc --env staging --format json | node "$root/scripts/ops/conflicting-secrets.ts")
for name in $names; do
  echo "deleting conflicting secret: $name"
  echo y | pnpm exec wrangler secret delete "$name" -c wrangler.staging.jsonc --env staging > /dev/null
done
