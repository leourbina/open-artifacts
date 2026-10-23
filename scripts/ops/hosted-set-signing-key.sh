#!/usr/bin/env bash
# Key ceremony (T3b R-N2, fix round 5): uploads one env's release signing key
# to the GitHub Environment hosted-<env>, and only when:
# - that Environment allows deployments from main only (a custom branch
#   policy that is exactly the branch `main`): the real control against a
#   dispatch from another ref;
# - it has a required reviewer, and admins cannot bypass it
#   (can_admins_bypass is false);
# - an active ruleset targets refs/tags/v* (nothing excluded) with creation,
#   update and deletion all restricted, and the only bypass actor is the
#   release App (RELEASE_APP_ID, its numeric App id).
# The upload is refused otherwise. The PEM key comes on stdin and goes to
# `gh secret set` on stdin: never in argv, a file or the output.
# Usage: <generate key> | RELEASE_APP_ID=<id> scripts/ops/hosted-set-signing-key.sh staging|prod
set -euo pipefail

env="${1:-}"
case "$env" in
  staging | prod) ;;
  *)
    echo "usage: <PEM key on stdin> | RELEASE_APP_ID=<id> $0 staging|prod" >&2
    exit 2
    ;;
esac
[ ! -t 0 ] || { echo "refusing: the key must come on stdin" >&2; exit 2; }
key=$(cat)
[ -n "$key" ] || { echo "refusing: no key on stdin" >&2; exit 2; }
app="${RELEASE_APP_ID:-}"
[[ "$app" =~ ^[1-9][0-9]*$ ]] || {
  echo "refusing: set RELEASE_APP_ID to the release App's numeric id (the only allowed tag-ruleset bypass)" >&2
  exit 2
}

name="hosted-$env"
repo="${OA_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
env_json=$(gh api "repos/$repo/environments/$name")
pol_json=$(gh api "repos/$repo/environments/$name/deployment-branch-policies")
list_json=$(gh api "repos/$repo/rulesets?includes_parents=true")
# Each tag ruleset's details (the list omits conditions, rules and bypass actors).
ids=$(LIST_JSON="$list_json" node -e '
try {
  for (const r of JSON.parse(process.env.LIST_JSON))
    if (r && r.target === "tag" && Number.isSafeInteger(r.id)) console.log(r.id);
} catch {}')
rulesets="["
for id in $ids; do
  [ "$rulesets" = "[" ] || rulesets+=","
  rulesets+=$(gh api "repos/$repo/rulesets/$id")
done
rulesets+="]"

# Prints nothing when every control holds, else the reason.
# shellcheck disable=SC2016 # the ${...} below are JS template literals, not shell
why=$(ENV_JSON="$env_json" POL_JSON="$pol_json" RULESETS_JSON="$rulesets" APP_ID="$app" node -e '
let e, p, rs;
try {
  e = JSON.parse(process.env.ENV_JSON);
  p = JSON.parse(process.env.POL_JSON);
  rs = JSON.parse(process.env.RULESETS_JSON);
} catch { console.log("the GitHub API reads are not JSON"); process.exit(0); }
const app = Number(process.env.APP_ID);
const reason = (() => {
  const d = e.deployment_branch_policy;
  if (!d) return "no deployment branch policy: every branch may deploy";
  if (d.protected_branches !== false || d.custom_branch_policies !== true)
    return "deployment branches are not a custom main-only list";
  const b = (p.branch_policies ?? []).map((x) => `${x.type ?? "branch"}:${x.name}`);
  if (b.length !== 1 || b[0] !== "branch:main")
    return `deployment branches are [${b.join(", ")}], not exactly branch main`;
  if (!(e.protection_rules ?? []).some((r) => r.type === "required_reviewers"))
    return "no required reviewer";
  if (e.can_admins_bypass !== false)
    return "admins can bypass the environment (can_admins_bypass is not false)";
  const ok = rs.some((r) => {
    const inc = r?.conditions?.ref_name?.include ?? [];
    const exc = r?.conditions?.ref_name?.exclude ?? [];
    const types = new Set((r?.rules ?? []).map((x) => x?.type));
    const by = r?.bypass_actors ?? [];
    return (
      r?.target === "tag" &&
      r?.enforcement === "active" &&
      inc.includes("refs/tags/v*") &&
      exc.length === 0 &&
      ["creation", "update", "deletion"].every((t) => types.has(t)) &&
      by.length === 1 &&
      by[0]?.actor_type === "Integration" &&
      by[0]?.actor_id === app
    );
  });
  if (!ok)
    return "no active ruleset on refs/tags/v* that restricts creation, update and deletion with only the release App (RELEASE_APP_ID) as bypass";
  return "";
})();
if (reason) console.log(reason);')
if [ -n "$why" ]; then
  echo "refusing to upload the $name signing key: $why" >&2
  exit 1
fi
printf '%s\n' "$key" | gh secret set RELEASE_SIGNING_KEY --env "$name" --repo "$repo"
echo "set RELEASE_SIGNING_KEY in $name ($repo): main-only deployments, required reviewer, no admin bypass, v* tags restricted to App $app"
