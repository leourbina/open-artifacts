#!/usr/bin/env bash
# Dispatch ci.yml on the release-please branch when its PR is open.
# Env: GITHUB_REPOSITORY, BRANCH (GH_TOKEN for gh).
set -euo pipefail
open=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$BRANCH" --state open --json headRefName --jq length)
if [ "$open" -gt 0 ]; then
  gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref "$BRANCH"
fi
