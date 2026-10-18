#!/usr/bin/env bash
# Dry-run release-please against the repo and prove biome accepts what it would write.
# Env: RELEASE_PLEASE (cmd, default release-please), BIOME_CMD (default "pnpm biome check"),
#      RD_ROOT (repo root, default git toplevel), RD_TOKEN, RD_REPO (default leourbina/open-artifacts).
set -euo pipefail

root="${RD_ROOT:-$(git rev-parse --show-toplevel)}"
rp="${RELEASE_PLEASE:-release-please}"
biome="${BIOME_CMD:-pnpm biome check}"
repo="${RD_REPO:-leourbina/open-artifacts}"
cd "$root"

out=$("$rp" release-pr --dry-run --repo-url="$repo" --token="${RD_TOKEN:-}" \
  --target-branch=main --config-file=release-please-config.json \
  --manifest-file=.release-please-manifest.json 2>&1) || {
  echo "$out"
  echo "FAIL: release-please exited non-zero" >&2
  exit 1
}
echo "$out"

current=$(node -p 'JSON.parse(require("fs").readFileSync(".release-please-manifest.json","utf8"))["."]')
pre1=$(node -p 'String(JSON.parse(require("fs").readFileSync("release-please-config.json","utf8")).packages["."]["bump-minor-pre-major"] === true && /^0\./.test("'"$current"'"))')

next=""
if grep -qE '^Would open 0 pull requests' <<<"$out"; then
  echo "No release proposed."
elif grep -qE '^Would open [1-9][0-9]* pull requests' <<<"$out"; then
  next=$(sed -nE 's/^title: .*release ([^ ]+)$/\1/p' <<<"$out" | head -n1)
  if ! grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$' <<<"$next"; then
    echo "FAIL: proposed version '$next' is not valid semver" >&2
    exit 1
  fi
  if [ "$pre1" = "true" ] && [ "${next%%.*}" != "0" ]; then
    echo "FAIL: proposed $next leaves 0.x while bump-minor-pre-major is true" >&2
    exit 1
  fi
  echo "Proposed version: $next"
else
  echo "FAIL: could not parse release-please output" >&2
  exit 1
fi

# Write files the way release-please does, then lint them. Originals are restored on exit.
bak=$(mktemp -d)
cp .release-please-manifest.json CHANGELOG.md package.json "$bak/"
trap 'cp "$bak/.release-please-manifest.json" "$bak/CHANGELOG.md" "$bak/package.json" "$root/"; rm -rf "$bak"' EXIT

v="${next:-$current}"
node -e '
const fs = require("fs");
const v = process.argv[1];
fs.writeFileSync(".release-please-manifest.json", JSON.stringify({ ".": v }));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = v;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
const old = fs.readFileSync("CHANGELOG.md", "utf8").replace(/^# Changelog\n+/, "");
const entry = `## [${v}](https://github.com/${process.argv[2]}/compare/v0.0.0...v${v}) (2026-01-01)\n\n\n### Features\n\n* **x:** sample ([#1](https://github.com/${process.argv[2]}/issues/1)) ([abc1234](https://github.com/${process.argv[2]}/commit/abc1234))\n\n`;
fs.writeFileSync("CHANGELOG.md", "# Changelog\n\n" + entry + old);
' "$v" "$repo"

# shellcheck disable=SC2086
$biome .release-please-manifest.json CHANGELOG.md package.json
echo "OK"
