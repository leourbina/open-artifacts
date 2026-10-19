#!/usr/bin/env bash
# Prints the staging CLOUDFLARE_API_TOKEN's id and status (never the token) so it can be found in the dashboard.
set -uo pipefail
: "${CLOUDFLARE_API_TOKEN:?missing}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# Token goes via stdin config, never argv.
code=$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
  curl -fsS -K - -o "$tmp/body" -w '%{http_code}' https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null) || true
[ "${code:-000}" = 200 ] || { echo "verify failed: http=${code:-000}"; exit 1; }
jq -r '"id=\(.result.id) status=\(.result.status)"' "$tmp/body"
