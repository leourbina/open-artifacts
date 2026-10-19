#!/usr/bin/env bash
# Prints the staging CLOUDFLARE_API_TOKEN's id and status (never the token) so it can be found in the dashboard.
set -uo pipefail
: "${CLOUDFLARE_API_TOKEN:?missing}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# Token goes via stdin config, never argv.
code=$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
  curl -fsS -m 20 -K - -o "$tmp/body" -w '%{http_code}' https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null) || true
[ "${code:-000}" = 200 ] || { echo "verify failed: http=${code:-000}"; exit 1; }
id=$(jq -r '.result.id // empty' "$tmp/body" 2>/dev/null); st=$(jq -r '.result.status // empty' "$tmp/body" 2>/dev/null)
[ -n "$id" ] && [ "$st" = active ] || { echo "unexpected verify result: id=${id:-?} status=${st:-?}"; exit 1; }
echo "id=$id status=$st"
