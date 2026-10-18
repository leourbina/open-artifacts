---
title: Set up Open Artifacts
description: Deploy your own instance to Cloudflare. Your agent does every step except the Cloudflare login.
order: 1
# TODO(B16 welcomeUrl): use selftest data.welcomeUrl in step 7 once Platform adds it.
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
5. **Run setup.** Use the user's hostnames and email:

   ```sh
   pnpm -s oa:setup --json --yes --app-host artifacts.example.com --content-host artifacts-content.example.com --owner-email you@example.com
   ```

   `-s` keeps pnpm's own output off stdout, so every line is JSON. With `--yes`, setup never prompts, so a missing value is an error. If the Cloudflare login can reach more than one account, add `--account-id <id>`. Setup prints one JSON object per line, `{"step", "status", "message", "data"}`, where `status` is `ok`, `skipped`, `action_required`, or `error`. It stops at the first `action_required` or `error`. Then go by the exit code:

   - **0:** every step is done. Go on to step 6.
   - **2:** the last line is `action_required`. Relay its `message` to the user verbatim, with `data.url` if it has one. Wait until they say it's done, then run the same command again. Setup saves its progress in `.openartifacts/state.json` and picks up where it stopped.
   - **1:** the last line is `error`. Show the user its `message` and stop.

   If the `access` step asks for an Access API token, the user creates one at its `data.url` and gives it to you. Run the same command again with it in the environment, `OA_ACCESS_TOKEN=<token> pnpm -s oa:setup --json --yes …`. Setup never saves it, and the `access` step checks Access again on every run except `--upgrade`, so set OA_ACCESS_TOKEN on every later run too, including `--new-owner-token` runs. Ask the user to keep the token until setup finishes, or to expect to create a new one.
6. **Connect yourself.** The `owner-token` line's `data.token` is the owner's personal access token (`oa_pat_…`). It's printed only once, by the run that mints it, so keep it. The `agent-config` line's `data.url` is the MCP URL, and its `data.snippets` holds ready-made MCP configs with the token filled in: `claudeCode`, `codex`, `cursor`, `opencode`, and a generic `json`. Add the one for *this* agent to your MCP config. If the snippets show `<YOUR_TOKEN>`, the token was minted by an earlier run: use the token from that run, or run setup again with `--new-owner-token`, which mints a new one and revokes the old one. See [Connect agents](/docs/connect-agents/) for each client's config format.
7. **Open the Welcome page.** The `selftest` line's `data.artifactId` is a Welcome artifact that setup published to test the connection. Give the user its link, `https://<app-host>/a/<artifactId>`, so they can sign in and see it. The Welcome artifact is published only by a run that mints the owner token; if the `selftest` line has no `artifactId`, give the user `https://<app-host>/` instead.

## Setup flags

Setup takes each value from its flag first, then from `.openartifacts/state.json` (saved by an earlier run), then by asking, unless `--yes` is set. After the first run, the hostnames and email can be left out.

| Flag | Meaning |
|---|---|
| `--name` | Name of the Worker, its resources, and the Access app. Defaults to `open-artifacts`. It's also the server name in the MCP snippets. |
| `--app-host` | The app hostname, for example `artifacts.example.com`. |
| `--content-host` | The artifact content hostname, for example `artifacts-content.example.com`. |
| `--owner-email` | The owner's email. That person becomes the owner and gets the owner token. |
| `--account-id` | The Cloudflare account to use. Defaults to `CLOUDFLARE_ACCOUNT_ID`, or the only account the login can reach. |
| `--yes` | Never prompt. Missing values are errors, and the optional `ANALYTICS_TOKEN` is skipped. |
| `--upgrade` | Upgrade an existing install: only `deploy` and `selftest` do work. See [Upgrade](/docs/upgrade/). |
| `--new-owner-token` | Mint a new owner token, and revoke the one setup minted before. |
| `--json` | Print one JSON object per line instead of text. |

| Environment variable | Meaning |
|---|---|
| `OA_ACCESS_TOKEN` | A Cloudflare API token for Access, when the `wrangler login` token can't manage it. |
| `CLOUDFLARE_ACCOUNT_ID` | The default for `--account-id`. |

Exit codes: `0` when every step is done, `2` when a step needs the user (`action_required`), and `1` on an error.

## What setup does

`oa:setup` is idempotent: each step checks first and skips work that's already done. The steps, in order:

1. **`prereqs`:** checks Node 22 or later, pnpm, the Cloudflare login and account, and that both hostnames are in a zone on that account.
2. **`resources`:** creates or reuses the D1 database, the R2 bucket, and the KV namespace, and writes `apps/server/wrangler.jsonc`.
3. **`access`:** creates the Cloudflare Access for SaaS application and its sign-in policy.
4. **`secrets`:** stores the Worker secrets. Without `--yes`, it also offers to store the optional `ANALYTICS_TOKEN` for the Usage page.
5. **`deploy`:** builds the server, applies database migrations, and deploys the Worker.
6. **`owner-token`:** mints a personal access token for the owner, unless setup already minted one that's still valid.
7. **`selftest`:** checks `/healthz` and the OIDC discovery document. When this run minted a token, it also publishes the Welcome artifact over MCP and checks that its content is served.
8. **`agent-config`:** prints the MCP URL and config snippets.

## Cloudflare Access permissions

The token from `wrangler login` may not be able to manage Zero Trust (Access). If it can't, the `access` step asks for an API token with Access: Apps and Policies Edit, Access: Organizations Read, and Zone: DNS Read, and links to a pre-filled form for creating one. Set it as `OA_ACCESS_TOKEN`; without `--yes`, you can paste it at the prompt instead. Setup doesn't keep it, and every later run except `--upgrade` needs it again, so keep it until setup finishes. If the account has no Zero Trust organization yet, setup links to the Zero Trust dashboard to turn it on. Zero Trust's free plan is enough.
