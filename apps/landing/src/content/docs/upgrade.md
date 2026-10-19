---
title: Upgrade
description: Move an existing instance to the latest release without losing data.
order: 6
---

Upgrades keep all your artifacts, versions, shares, and live-page data. Database migrations only add to the schema; they never rename or drop anything your data depends on.

## Steps

1. **Go to the existing install:** `cd` into the `open-artifacts` directory that setup ran from. If it's gone, for example on a new machine or in CI, clone the latest release as in [setup](/docs/setup/) and continue from step 3. Without its saved state, add the install's `--name`, `--app-host`, `--content-host`, and `--owner-email` to the commands below; setup rebuilds the state from Cloudflare by `--name` and never guesses the name in a `--json` run. It also re-verifies Access, so set `OA_ACCESS_TOKEN` (as in setup) if the Cloudflare login can't read Access.
2. **Check out the latest release.** This is the latest stable GitHub release; pre-releases are skipped. Release tags look like `vX.Y.Z`:

   ```sh
   TAG=$(curl -fsSL {LATEST_RELEASE_API} | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
   git fetch --depth 1 origin tag "$TAG"
   git checkout "$TAG"
   ```

   If `TAG` comes back empty or `curl` fails, stop and tell the user: "Open Artifacts has no stable release yet; check back later."
3. **Install dependencies:** `pnpm install`.
4. **Preview, if you like:** `pnpm -s oa:setup --upgrade --check --json` is read-only. It reports each step as `done` or `todo` without changing anything, so you can see what the upgrade would do.
5. **Run the upgrade:** `pnpm -s oa:setup --upgrade --json`. It reuses the hostnames and email saved by setup. Every step runs, but only `deploy` (new database migrations, then a redeploy) and `selftest` do work: `prereqs` and `resources` verify, and `access`, `secrets`, `owner-token`, and `agent-config` report `skipped` unless something is missing. It keeps the existing owner token and needs no `OA_ACCESS_TOKEN` when the state is saved. It never creates resources: if one is missing, it reports `action_required` and asks for a full setup. Go by the exit code, as in setup:
   - **0:** done.
   - **2:** relay the `action_required` line's `message` to the user verbatim, wait until they've done it, then run the same command again.
   - **1:** show the user the `error` line's `message`. If it says to rerun setup without `--upgrade`, run `pnpm -s oa:setup --json` (it may need the Access token again: save it with the line from `pnpm -s oa:setup --token-links --json` (`saveCommand`) in your own terminal; in Claude Code, type `! ` then the line; never paste a token into the chat; a plain non-interactive shell can't hide input, so use a real terminal if `read` fails; setup then reads `~/.open-artifacts/<name>-access-token`), then the upgrade again.
6. **Tell the user** which version is now running: the `deploy` line's `data.deployedVersion`.

## If the Cloudflare login has expired

The `prereqs` step fails with an error. Ask the user to run `npx wrangler login` again, then re-run the upgrade.
