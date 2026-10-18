#!/usr/bin/env bash
# First production install via `@oa/setup --ci`. Never prints the owner token.
set -uo pipefail

: "${PROD_NAME:?}" "${PROD_APP_HOST:?}" "${PROD_CONTENT_HOST:?}" "${PROD_OWNER_EMAIL:?}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
[[ " $* " == *" --ci "* ]] || { echo "--ci required" >&2; exit 2; }

run_setup() {
  if pnpm -s oa:setup "$@" --name "$PROD_NAME" --app-host "$PROD_APP_HOST" \
    --content-host "$PROD_CONTENT_HOST" --owner-email "$PROD_OWNER_EMAIL" 2>&1; then
    echo '{"step":"setup-exit","status":"ok"}'
  else
    echo '{"step":"setup-exit","status":"error"}'
  fi
}

pat='oa_pat_[1-9A-HJ-NP-Za-km-z]{32}'
bad=0
{
  echo "| step | status |"
  echo "|---|---|"
} >>"$summary"

while IFS= read -r line; do
  if [[ "$line" =~ $pat ]]; then
    echo "token pattern found in output; aborting" >&2
    exit 1
  fi
  echo "$line"
  step=$(jq -r '.step // "?"' <<<"$line" 2>/dev/null || echo "?")
  status=$(jq -r '.status // empty' <<<"$line" 2>/dev/null || true)
  [[ -z "$status" ]] && continue
  echo "| $step | $status |" >>"$summary"
  case "$status" in error | action_required) bad=1 ;; esac
done < <(run_setup "$@")

exit "$bad"
