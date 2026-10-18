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
4. **Run the upgrade:** `pnpm oa:setup --upgrade --json`. It applies new migrations and redeploys the Worker. Relay any `action_required` message to the user verbatim, then run it again.
5. **Tell the user** which version is now running.

## If the Cloudflare login has expired

`oa:setup` reports this as an `action_required` item. Ask the user to run `npx wrangler login` again, then re-run the upgrade.
