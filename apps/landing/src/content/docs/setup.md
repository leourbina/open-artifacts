---
title: Set up Open Artifacts
description: Deploy your own instance to Cloudflare. Your agent does every step except the Cloudflare login.
order: 1
# Remove when B16 lands and every oa:setup flag and output field is verified.
fallback: B16
---

Open Artifacts runs on your own Cloudflare account and domain. The easiest way to install it is to tell your coding agent:

> Set up open-artifacts.com/llms.txt

The agent follows the steps below. The only thing you do yourself is approve the Cloudflare login in your browser.

## What you need

- **Node.js 22 or later**, with pnpm (`corepack enable` provides it).
- **git**.
- **A Cloudflare account.** The free plan is enough.
- **A domain on Cloudflare.** Open Artifacts uses two hostnames on it: one for the app (for example `artifacts.example.com`) and one for artifact content (for example `artifacts-content.example.com`).

## Steps

1. **Check the prerequisites.** Run `node --version`, `pnpm --version`, and `git --version`. If anything is missing, or the user has no Cloudflare account or no domain on Cloudflare, explain what it is and how to get it, then wait.
2. **Clone the latest release.** Open Artifacts installs from the latest tagged release, not `main`. Release tags look like `vX.Y.Z`:

   ```sh
   REPO={REPO_URL}
   TAG=$(git ls-remote --tags --refs --sort=-v:refname "$REPO" '*v*' \
     | sed -n 's#.*refs/tags/##p' \
     | grep -E '(^|-)v[0-9]+\.[0-9]+\.[0-9]+$' \
     | sed -E 's/^(.*-)?v([0-9.]+)$/\2 &/' | sort -rV | head -n1 | cut -d' ' -f2)
   git clone --depth 1 --branch "$TAG" "$REPO" open-artifacts
   cd open-artifacts
   ```

3. **Install dependencies:** `pnpm install`.
4. **Ask the user to log in to Cloudflare.** Ask them to run `npx wrangler login` and approve access in the browser. On a remote machine or in a container, use `npx wrangler login --device` instead. This is the one step a person has to do.
5. **Run setup:** `pnpm oa:setup --json`. Pass the app hostname, the content hostname, and the owner's email as flags (`--app-host`, `--content-host`, `--owner-email`), or setup will ask for them. Setup prints JSON. When it reports an `action_required` item, relay its message to the user verbatim, wait until they've done it, and run the same command again. Setup is safe to re-run.
6. **Connect yourself.** Write your MCP config using the snippet setup prints for *this* agent. It contains the instance's MCP URL and a personal access token as a Bearer header. See [Connect agents](/docs/connect-agents/) for each client's config format.
7. **Open the Welcome link.** Setup publishes a Welcome artifact. Give the user its link so they can sign in to the dashboard.

## What setup does

`oa:setup` is idempotent. Each run:

1. Creates or reuses the D1 database, the R2 bucket, and the KV namespace, and writes `wrangler.jsonc`.
2. Applies database migrations.
3. Creates the Cloudflare Access for SaaS application and its sign-in policy, and stores the OIDC secrets as Worker secrets.
4. Deploys the Worker on both hostnames.
5. Runs a self-test: a health check, an OIDC discovery check, and a test publish.
6. Mints a personal access token for the owner and prints MCP config snippets.

## Cloudflare Access permissions

The token from `wrangler login` may not include Zero Trust (Access) permissions. If it doesn't, setup prints a link to create a scoped API token. Paste it in once; setup uses it and doesn't keep it. If the account has no Zero Trust organization yet, setup walks you through turning it on. Zero Trust's free plan is enough.
