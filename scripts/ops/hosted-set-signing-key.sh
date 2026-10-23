#!/usr/bin/env bash
# Key ceremony (T3b R-N2): uploads one env's release signing key to the
# GitHub Environment hosted-<env>, and only when that Environment allows
# deployments from main only (a custom branch policy that is exactly the
# branch `main`) and has a required reviewer. That branch policy is the real
# control against a dispatch from another ref, so the upload is refused
# otherwise. The PEM key comes on stdin and goes to `gh secret set` on stdin:
# never in argv, a file or the output.
# Usage: <generate key> | scripts/ops/hosted-set-signing-key.sh staging|prod
set -euo pipefail

env="${1:-}"
case "$env" in
  staging | prod) ;;
  *)
    echo "usage: <PEM key on stdin> | $0 staging|prod" >&2
    exit 2
    ;;
esac
[ ! -t 0 ] || { echo "refusing: the key must come on stdin" >&2; exit 2; }
key=$(cat)
[ -n "$key" ] || { echo "refusing: no key on stdin" >&2; exit 2; }

name="hosted-$env"
repo="${OA_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
env_json=$(gh api "repos/$repo/environments/$name")
pol_json=$(gh api "repos/$repo/environments/$name/deployment-branch-policies")

# Prints nothing when hosted-<env> is main-only with a required reviewer,
# else the reason.
# shellcheck disable=SC2016 # the ${...} below is a JS template literal, not shell
why=$(ENV_JSON="$env_json" POL_JSON="$pol_json" node -e '
let e, p;
try { e = JSON.parse(process.env.ENV_JSON); p = JSON.parse(process.env.POL_JSON); }
catch { console.log("the environment reads are not JSON"); process.exit(0); }
const d = e.deployment_branch_policy;
if (!d) console.log("no deployment branch policy: every branch may deploy");
else if (d.protected_branches !== false || d.custom_branch_policies !== true)
  console.log("deployment branches are not a custom main-only list");
else {
  const b = (p.branch_policies ?? []).map((x) => `${x.type ?? "branch"}:${x.name}`);
  if (b.length !== 1 || b[0] !== "branch:main")
    console.log(`deployment branches are [${b.join(", ")}], not exactly branch main`);
  else if (!(e.protection_rules ?? []).some((r) => r.type === "required_reviewers"))
    console.log("no required reviewer");
}')
if [ -n "$why" ]; then
  echo "refusing to upload the $name signing key: $why" >&2
  exit 1
fi
printf '%s\n' "$key" | gh secret set RELEASE_SIGNING_KEY --env "$name" --repo "$repo"
echo "set RELEASE_SIGNING_KEY in $name ($repo): deployment branches main only, required reviewer present"
