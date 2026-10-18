#!/usr/bin/env bash
# File a blocker for the repo owner: an issue labeled "blocker", assigned to
# leourbina, added to the "Open Artifacts" project with "Raised by" set.
#
# Usage: scripts/oa-blocker.sh "<session name>" "<short title>" "<what you need and why>"
#   e.g. scripts/oa-blocker.sh "OpenArtifacts Platform" "Approve Access app" "B4 needs …"
set -euo pipefail

REPO="leourbina/open-artifacts"
OWNER="leourbina"
PROJECT_NUMBER=1
PROJECT_ID="PVT_kwHOAAafZM4BnnbZ"
RAISED_BY_FIELD="PVTF_lAHOAAafZM4BnnbZzhmLLuE"

if [[ $# -ne 3 ]]; then
  echo "usage: $0 \"<session name>\" \"<short title>\" \"<body>\"" >&2
  exit 64
fi
session="$1" title="$2" body="$3"

url=$(gh issue create -R "$REPO" \
  --title "[$session] $title" \
  --label blocker \
  --assignee "$OWNER" \
  --body "$(printf '**Raised by:** %s\n\n%s\n\n---\nClose this issue (or comment) when unblocked; the raising session watches it.' "$session" "$body")")

item=$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" --format json -q .id)
gh project item-edit --id "$item" --project-id "$PROJECT_ID" --field-id "$RAISED_BY_FIELD" --text "$session" >/dev/null

echo "$url"
