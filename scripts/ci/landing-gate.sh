#!/usr/bin/env bash
# Write present=true|false to $GITHUB_OUTPUT depending on whether apps/landing exists yet.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -f "${LANDING_CONFIG:-$root/apps/landing/wrangler.jsonc}" ]; then echo "present=true" >> "$GITHUB_OUTPUT"; else echo "present=false" >> "$GITHUB_OUTPUT"; fi
