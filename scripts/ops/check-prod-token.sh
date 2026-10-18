#!/usr/bin/env bash
# Read-only check of PROD_CLOUDFLARE_API_TOKEN (passed in as PROD_CLOUDFLARE_API_TOKEN env).
# Needs: PROD_CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID. Optional ZONE_NAME.
set -uo pipefail
: "${PROD_CLOUDFLARE_API_TOKEN:?missing}" "${CLOUDFLARE_ACCOUNT_ID:?missing}"
ZONE_NAME="${ZONE_NAME:-leourbina.com}"
ID="$CLOUDFLARE_ACCOUNT_ID"
API="https://api.cloudflare.com/client/v4"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fails=0
rows="| Check | Result | Detail |
|---|---|---|
"

# get PATH -> sets $code, body in $tmp/body. Token goes via stdin config, never argv.
get() {
  : >"$tmp/body"
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$PROD_CLOUDFLARE_API_TOKEN" |
    curl -fsS -K - -o "$tmp/body" -w '%{http_code}' "$API$1" 2>/dev/null) || true
  code="${code:-000}"
}
jq_() { jq -r "$1" "$tmp/body" 2>/dev/null; }
record() { # name ok detail missing-permission
  if [ "$2" = 1 ]; then
    echo "PASS  $1 ${3:+($3)}"
    rows+="| $1 | pass | ${3:-} |
"
  else
    echo "FAIL  $1 ${3:+($3)} - missing permission: $4"
    rows+="| $1 | FAIL | ${3:+$3; }missing permission: $4 |
"
    fails=$((fails + 1))
  fi
}

get /user/tokens/verify
st=$(jq_ '.result.status')
[ "$code" = 200 ] && [ "$st" = active ] && ok=1 || ok=0
record "Token: active" "$ok" "status=${st:-?} http=$code" "valid active token"

get "/zones?name=$ZONE_NAME&account.id=$ID"
n=$(jq_ '.result | length'); zst=$(jq_ '.result[0].status'); zid=$(jq_ '.result[0].id')
[ "$code" = 200 ] && [ "$n" = 1 ] && [ "$zst" = active ] && ok=1 || ok=0
record "Zone: $ZONE_NAME" "$ok" "zones=${n:-?} status=${zst:-?} http=$code" "Zone: Zone Read (token must include zone $ZONE_NAME)"

get "/accounts/$ID/access/organizations"
ad=$(jq_ '.result.auth_domain')
[ "$code" = 200 ] && ok=1 || ok=0
record "Access: Organizations" "$ok" "auth_domain=${ad:-?} http=$code" "Access: Organizations Read"

get "/accounts/$ID/workers/scripts"
[ "$code" = 200 ] && ok=1 || ok=0
record "Workers: Scripts" "$ok" "http=$code" "Workers Scripts Edit"

get "/accounts/$ID/d1/database?per_page=1"
[ "$code" = 200 ] && ok=1 || ok=0
record "D1" "$ok" "http=$code" "D1 Edit"

if [ -n "${zid:-}" ] && [ "$zid" != null ]; then
  get "/zones/$zid/dns_records?per_page=1"
  [ "$code" = 200 ] && ok=1 || ok=0
  record "Zone: DNS" "$ok" "http=$code" "Zone: DNS Edit"
else
  record "Zone: DNS" 0 "no zone id" "Zone: DNS Edit (zone not found)"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Production token check"; echo; printf '%s\n' "$rows"; } >>"$GITHUB_STEP_SUMMARY"
fi
[ "$fails" = 0 ] || { echo "$fails check(s) failed"; exit 1; }
echo "all checks passed"
