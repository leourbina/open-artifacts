---
title: Upgrade
description: Move an existing instance to the latest release without losing data.
order: 6
---

Upgrades keep all your artifacts, versions, shares, and live-page data. Database migrations only add to the schema; they never rename or drop anything your data depends on.

## Steps

1. **Go to the existing install:** `cd` into the `open-artifacts` directory that setup ran from.
2. **Check out the latest release.** Release tags look like `vX.Y.Z`:

   ```sh
   TAG=$(git ls-remote --tags --refs --sort=-v:refname origin '*v*' \
     | sed -n 's#.*refs/tags/##p' \
     | grep -E '(^|-)v[0-9]+\.[0-9]+\.[0-9]+$' \
     | sed -E 's/^(.*-)?v([0-9.]+)$/\2 &/' | sort -rV | head -n1 | cut -d' ' -f2)
   git fetch --depth 1 origin tag "$TAG"
   git checkout "$TAG"
   ```

3. **Install dependencies:** `pnpm install`.
4. **Run the upgrade:** `pnpm -s oa:setup --upgrade --json`. It reuses the hostnames and email saved by setup. Every step runs, but only `deploy` (new database migrations, then a redeploy) and `selftest` do work: `prereqs` and `resources` verify, and `access`, `secrets`, `owner-token`, and `agent-config` report `skipped` unless something is missing. It keeps the existing owner token and needs no `OA_ACCESS_TOKEN`. Go by the exit code, as in setup:
   - **0:** done.
   - **2:** relay the `action_required` line's `message` to the user verbatim, wait until they've done it, then run the same command again.
   - **1:** show the user the `error` line's `message`. If it says to rerun setup without `--upgrade`, run `pnpm -s oa:setup --json` (it may ask for `OA_ACCESS_TOKEN` again), then the upgrade again.
5. **Tell the user** which version is now running: the `deploy` line's `data.deployedVersion`.

## If the Cloudflare login has expired

The `prereqs` step fails with an error. Ask the user to run `npx wrangler login` again, then re-run the upgrade.
