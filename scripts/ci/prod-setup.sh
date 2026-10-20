#!/usr/bin/env bash
# Production setup via @oa/setup. Never prints the owner token or ANALYTICS_TOKEN
# (read by the setup secrets step from env, when set).
# Usage: prod-setup.sh <install|preflight|upgrade|cleanup>
#        prod-setup.sh <demo-install|demo-upgrade|demo-cleanup>   (the public demo; reads DEMO_*)
# The demo modes run the same wrapper (oa_pat_ and ANALYTICS_TOKEN scan, status handling).
set -uo pipefail

case "${1:-}" in
  demo-*)
    # The demo must never target the production Worker or its hosts.
    if [[ "${DEMO_NAME:-}" == "open-artifacts-prod" || "${DEMO_NAME:-}" == "${PROD_NAME:-@}" ||
      "${DEMO_APP_HOST:-}" == "artifacts.leourbina.com" ]]; then
      echo "demo setup refuses the production name or host" >&2
      exit 2
    fi
    PROD_NAME="${DEMO_NAME:-}" PROD_APP_HOST="${DEMO_APP_HOST:-}"
    PROD_CONTENT_HOST="${DEMO_CONTENT_HOST:-}" PROD_OWNER_EMAIL="${DEMO_OWNER_EMAIL:-}"
    ;;
esac
: "${PROD_NAME:?}" "${PROD_APP_HOST:?}" "${PROD_CONTENT_HOST:?}" "${PROD_OWNER_EMAIL:?}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
mode="${1:-}"
# Prod is Workers Paid, but stateless CI reads the plan as unknown and --json
# never guesses team or the PLAN var: thumbnails (--browser), solo and
# --plan paid are explicit. Email for prod comes later, in its own change.
case "$mode" in
  install) mode_args=(--ci --solo --browser --plan paid) ;;
  preflight) mode_args=(--check --strict --upgrade --solo --browser --plan paid) ;; # read-only; fails if absent or drifted
  upgrade) mode_args=(--ci --upgrade --solo --browser --plan paid) ;;
  cleanup) mode_args=(--ci --revoke-ci-tokens) ;;
  demo-install) mode_args=(--ci --json --solo --no-email --yes-paid) ;;
  demo-upgrade) mode_args=(--ci --json --upgrade --solo --no-email --yes-paid) ;;
  demo-cleanup) mode_args=(--ci --revoke-ci-tokens) ;;
  *) echo "usage: $0 <install|preflight|upgrade|cleanup|demo-install|demo-upgrade|demo-cleanup>" >&2; exit 2 ;;
esac

run_setup() {
  if pnpm -s oa:setup "${mode_args[@]}" --name "$PROD_NAME" --app-host "$PROD_APP_HOST" \
    --content-host "$PROD_CONTENT_HOST" --owner-email "$PROD_OWNER_EMAIL" 2>&1; then
    echo '{"step":"setup-exit","status":"ok"}'
  else
    echo '{"step":"setup-exit","status":"error"}'
  fi
}

pat='oa_pat_[1-9A-HJ-NP-Za-km-z]{32}'
# ANALYTICS_TOKEN as given and as setup uses it (trimmed): either one leaking aborts.
an_raw="${ANALYTICS_TOKEN:-}"
an_trim="${an_raw#"${an_raw%%[![:space:]]*}"}"
an_trim="${an_trim%"${an_trim##*[![:space:]]}"}"
leaks() {
  [[ -n "$an_trim" && "$1" == *"$an_trim"* ]] || [[ -n "${an_raw//[[:space:]]/}" && "$1" == *"$an_raw"* ]]
}
bad=0
{
  echo "| step | status |"
  echo "|---|---|"
} >>"$summary"

while IFS= read -r line; do
  if [[ "$line" =~ $pat ]] || leaks "$line"; then
    echo "token pattern found in output; aborting" >&2
    exit 1
  fi
  echo "$line"
  step=$(jq -r '.step // "?"' <<<"$line" 2>/dev/null || echo "?")
  status=$(jq -r '.status // empty' <<<"$line" 2>/dev/null || true)
  [[ -z "$status" ]] && continue
  echo "| $step | $status |" >>"$summary"
  case "$status" in error | action_required) bad=1 ;; esac
done < <(run_setup)

exit "$bad"
