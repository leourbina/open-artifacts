#!/usr/bin/env bash
# Deploy needs apps/dashboard/dist to exist; write a placeholder if the build produced none.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dist="${DASHBOARD_DIST:-$root/apps/dashboard/dist}"
mkdir -p "$dist"
[ -f "$dist/index.html" ] || echo '<!doctype html><title>Open Artifacts</title>' > "$dist/index.html"
