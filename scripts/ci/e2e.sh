#!/usr/bin/env bash
# The CI e2e job (no secrets; the real suite runs a local `wrangler dev` only).
#   e2e.sh version  -> playwright=<version of @oa/dashboard's @playwright/test> to $GITHUB_OUTPUT
#   e2e.sh install  -> Chromium and WebKit with their OS deps
#   e2e.sh hosts    -> app.localhost and content.localhost resolve to 127.0.0.1
#   e2e.sh mock|real -> one suite, html report in playwright-report/<suite>
#   e2e.sh ui       -> @oa/ui real-browser checks (axe contrast, focus outlines)
#   e2e.sh landing  -> landing real-browser checks (no horizontal overflow)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hosts_file="${HOSTS_FILE:-/etc/hosts}"

case "${1:-}" in
  version)
    v="$(node -p "require('$root/apps/dashboard/node_modules/@playwright/test/package.json').version")"
    echo "playwright=$v" >> "$GITHUB_OUTPUT"
    ;;
  install)
    pnpm --filter @oa/dashboard exec playwright install --with-deps chromium webkit
    ;;
  hosts)
    # systemd-resolved already maps *.localhost; this makes it independent of the resolver.
    grep -q "app.localhost content.localhost" "$hosts_file" ||
      echo "127.0.0.1 app.localhost content.localhost" | sudo tee -a "$hosts_file" > /dev/null
    ;;
  mock)
    PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/mock \
      pnpm --filter @oa/dashboard exec playwright test --reporter=list,html
    ;;
  real)
    PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/real \
      pnpm --filter @oa/dashboard exec playwright test -c playwright.real.config.ts
    ;;
  ui)
    pnpm --filter @oa/ui test:browser
    ;;
  landing)
    pnpm --filter @oa/landing test:browser
    ;;
  *)
    echo "usage: e2e.sh version|install|hosts|mock|real|ui|landing" >&2
    exit 2
    ;;
esac
