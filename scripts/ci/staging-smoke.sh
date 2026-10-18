#!/usr/bin/env bash
# Staging smoke checks. Usage: staging-smoke.sh healthz|robots|login <base-url>
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
check="${1:?check required}"
base="${2:?base url required}"
retry=(--retry 20 --retry-delay 5 --retry-max-time 180 --retry-all-errors)

case "$check" in
  healthz)
    body=$(curl -fsS "${retry[@]}" "$base/healthz")
    echo "$body"
    grep -q '"ok":true' <<< "$body"
    ;;
  robots)
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    headers=$(curl -fsS -D - -o "$tmp" "${retry[@]}" "$base/robots.txt")
    body=$(cat "$tmp")
    grep -iq '^x-robots-tag: noindex, nofollow' <<< "$headers"
    grep -q 'Disallow: /' <<< "$body"
    ;;
  login)
    config="${WRANGLER_CONFIG:-$root/apps/server/wrangler.staging.jsonc}"
    team=$(sed -n 's/.*"ACCESS_TEAM_DOMAIN": *"\([^"]*\)".*/\1/p' "$config" | head -1)
    [ -n "$team" ] || { echo "::error::ACCESS_TEAM_DOMAIN not found in wrangler.staging.jsonc"; exit 1; }
    # keep only the last response's headers (retries append blocks)
    headers=$(curl -fsS -D - -o /dev/null "${retry[@]}" "$base/auth/login" | tr -d '\r' | awk 'BEGIN{RS="";ORS="\n"} {b=$0} END{print b}')
    echo "$headers"
    status=$(head -1 <<< "$headers")
    case "$status" in HTTP/*" 302"*) ;; *) echo "::error::/auth/login did not return 302 ($status)"; exit 1 ;; esac
    loc=$(grep -i '^location:' <<< "$headers" | head -1 | sed 's/^[^:]*: *//')
    prefix="https://$team/cdn-cgi/access/sso/oidc/"
    [ "${loc#"$prefix"}" != "$loc" ] || { echo "::error::/auth/login Location does not start with $prefix"; exit 1; }
    ;;
  *) echo "unknown check: $check" >&2; exit 2 ;;
esac
