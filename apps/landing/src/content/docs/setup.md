---
title: Set up Open Artifacts
description: Deploy your own instance to Cloudflare. Your agent does every step except the Cloudflare login.
order: 1
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
2. **Clone the latest release.** Open Artifacts installs from the latest stable GitHub release, not `main` and not a pre-release. Release tags look like `vX.Y.Z`:

   ```sh
   REPO={REPO_URL}
   TAG=$(curl -fsSL {LATEST_RELEASE_API} | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
   git clone --depth 1 --branch "$TAG" "$REPO" open-artifacts
   cd open-artifacts
   ```

   If `TAG` comes back empty or `curl` fails, stop and tell the user: "Open Artifacts has no stable release yet; check back later."
3. **Install dependencies:** `pnpm install`.
4. **Ask the user to log in to Cloudflare.** Ask them to run `npx wrangler login` and approve access in the browser. On a remote machine or in a container, use `npx wrangler login --device` instead. This is the one step a person has to do.
5. **Run setup.** Use the user's hostnames and email:

   ```sh
   pnpm -s oa:setup --json --app-host artifacts.example.com --content-host artifacts-content.example.com --owner-email you@example.com --name open-artifacts
   ```

   `-s` keeps pnpm's own output off stdout, so every line is JSON. With `--json`, setup never prompts. Setup prints one JSON object per line, `{"step", "status", "message", "data"}`, where `status` is `ok`, `skipped`, `action_required`, or `error`. It stops at the first `action_required` or `error`. Then go by the exit code:

   - **0:** every step is done. Go on to step 6.
   - **2:** the last line is `action_required`. If its `message` asks you to pass a flag, such as `--account-id` when the login can reach several accounts, add that flag and run again; ask the user for the value if you don't know it. Otherwise relay the `message` to the user verbatim, with `data.url` if it has one, wait until they say it's done, and run the same command again. Setup saves its progress in `.openartifacts/state.json` and picks up where it stopped.
   - **1:** the last line is `error`. Show the user its `message` and stop.

   If the `access` step asks for an Access API token, the user creates one at its `data.url`. Ask them to run this in the terminal where setup runs and paste the token, which isn't shown or saved in shell history:

   ```sh
   read -rs OA_ACCESS_TOKEN; export OA_ACCESS_TOKEN
   ```

   Then run the same command again. Never put the token on a command line, where shell history keeps it. Setup never saves it. Once Access is set up, runs without the token skip re-checking Access, as long as the app host and Cloudflare account stay the same. The token is needed again only to change the app host or account, or to re-check Access.

   Ask the user "Just you, or a team?" before the first run. For just them, add `--solo` (the default with `--json`). For a team, add `--team`: the `email` step then sets up invite email through Cloudflare Email Sending, which needs the Workers Paid plan. Setup can't always read the plan, so confirm it with the user and add `--yes-paid`; without it, setup turns email off and says why. The `email` step's `action_required` asks the user to onboard the sending domain (`mail.<app host>` by default) in the Cloudflare dashboard: relay its `message` and `data.records`, wait, and run again. If the domain already has mail records, setup asks for `--yes-email-domain` first; relay its warning to the user before passing it.
6. **Connect yourself.** The `owner-token` line's `data.token` is the owner's personal access token (`oa_pat_…`). It's shown only once, by the run that mints it, so keep it. The `agent-config` line's `data.url` is the MCP URL, and its `data.snippets` holds MCP configs for `claudeCode`, `codex`, `cursor`, `opencode`, and a generic `json`. They don't contain the token: most read it from the `OA_TOKEN` environment variable, and `json` has a `<YOUR_TOKEN>` placeholder to replace, in a file kept out of git. Add the one for *this* agent to your MCP config, and make the token available as `OA_TOKEN` to its client. If you've lost the token, run setup again with `--new-owner-token`, which mints a new one and revokes the old one. Connect agents shows each client's config format.
7. **Open the Welcome page.** Setup publishes a Welcome artifact to test the connection. Give the user its link, `data.welcomeUrl` on the `selftest` and `agent-config` lines, so they can sign in and see it. Only a run that mints the owner token publishes it; if there's no `welcomeUrl`, give the user `https://<app-host>/` instead.

## Setup flags

Setup takes each value from its flag first, then from `.openartifacts/state.json` (saved by an earlier run), then by asking, unless `--json` or `--yes` is set. After the first run, the hostnames and email can be left out.

| Flag | Meaning |
|---|---|
| `--name` | Name of the Worker, its resources, and the Access app. It's also the server name in the MCP snippets. Without saved state, it's required with `--json`, `--yes`, `--upgrade`, or `--check`; only an interactive run defaults it to `open-artifacts`. |
| `--app-host` | The app hostname, for example `artifacts.example.com`. |
| `--content-host` | The artifact content hostname, for example `artifacts-content.example.com`. |
| `--owner-email` | The owner's email. That person becomes the owner and gets the owner token. |
| `--account-id` | The Cloudflare account to use. Defaults to `CLOUDFLARE_ACCOUNT_ID`, or the only account the login can reach. |
| `--yes` | Never prompt. Missing values are errors, and the optional `ANALYTICS_TOKEN` is skipped. Optional with `--json`. |
| `--upgrade` | Upgrade an existing install: only `deploy` and `selftest` do work. See [Upgrade](/docs/upgrade/). |
| `--new-owner-token` | Mint a new owner token, and revoke the one setup minted before. |
| `--check` | Read-only. Runs each step's check without doing the work, and reports it as `done` or `todo`. Without saved state, it rebuilds the state from Cloudflare by `--name` and reports it on a last `state` line. It changes nothing on Cloudflare and writes no files. |
| `--strict` | Only with `--check`: exit `2` when any step is `todo`, for example to gate CI. |
| `--json` | Print one JSON object per line instead of text, and never prompt: a missing value is an `action_required` line naming the flag to pass. The optional `ANALYTICS_TOKEN` is skipped. |
| `--ci` | CI mode: implies `--json`; the owner token is used only for selftest, never printed, and revoked at the end of the run (also on SIGTERM or SIGINT). Requires `--name`; not with `--new-owner-token`. It keeps no `state.json`, so it reuses the welcome artifact by title instead of tracking its id. A SIGKILL or out-of-memory kill can leave a `setup-ci` token live; it is never printed. Find it by the label `setup-ci` in Settings → Tokens. The next `--ci` run revokes it before minting, or run `--ci --revoke-ci-tokens` as an `if: always()` cleanup step. |
| `--revoke-ci-tokens` | Only with `--ci`: revoke every live `setup-ci` token of the owner and exit. Needs `--name` and the owner email, not the hosts. |
| `--no-browser` | Omit the `BROWSER` binding (Browser Run, used for server-side thumbnails). Default is on and free-plan safe: Cloudflare caps Free usage (10 browser-minutes/day) and does not bill it, and no extra token permission is needed. The choice is saved in `state.json`, so `--upgrade` keeps it; stateless runs (`--ci`) must repeat the flag. `--check` and `--json` report `browser: true` or `false`. |
| `--solo` | Just you: no invite email, so no `send_email` binding. The default when setup can't ask (`--json`, `--yes`, `--ci`). Saved in `state.json` as `team: false`. |
| `--team` | A team: turns on the `email` step, which sets up invite email with Cloudflare Email Sending (Workers Paid only) and renders the `send_email` binding `EMAIL` and the `EMAIL_FROM` var (`noreply@<sending domain>`). Saved in `state.json` as `team`, `email` and `emailDomain`, so `--upgrade` keeps it; `--check` and `--json` report them. Not with `--solo`. |
| `--no-email` | With `--team`: leave email off (no `send_email` binding). |
| `--email-domain` | The Email Sending domain. Defaults to `mail.<app host>`, a subdomain, so your existing mail is untouched. Onboard it in the Cloudflare dashboard under Email Service, Email Sending, Onboard Domain; setup checks its `cf-bounce` MX, SPF and DKIM records and `_dmarc`, and re-checks on every run. |
| `--yes-email-domain` | Confirm a sending domain that already has MX or SPF records for another provider. Onboarding adds `_dmarc` with `p=reject`, which can break existing mail at a zone apex. Without it, setup asks interactively or returns `action_required`. |
| `--yes-paid` | Confirm the account is on Workers Paid. Setup checks the account subscriptions when the token can read billing, which the `wrangler login` token can't; otherwise it asks, and with `--json` it turns email off unless this flag is set. |
| `--help` | Print usage and exit (`-h` also works). |

| Environment variable | Meaning |
|---|---|
| `OA_ACCESS_TOKEN` | A Cloudflare API token for Access, needed on the first run when the `wrangler login` token can't manage Access, and again to change the app host or account. |
| `CLOUDFLARE_ACCOUNT_ID` | The default for `--account-id`. |
| `OA_TEAM_DOMAIN` | The Zero Trust team domain (`<team>.cloudflareaccess.com`), used when rebuilding state if the token can't read the Access organization. Setup verifies it before use. |

Exit codes: `0` when every step is done, `2` when a step needs the user or a missing flag (`action_required`), and `1` on an error. With `--check`, `0` means the checks ran; `--strict` makes a `todo` step exit `2`.

## What setup does

`oa:setup` is idempotent: each step checks first and skips work that's already done. The steps, in order:

1. **`prereqs`:** checks Node 22 or later, pnpm, the Cloudflare login and account, and that both hostnames are in a zone on that account.
2. **`resources`:** creates or reuses the D1 database, the R2 bucket, and the KV namespace, and writes `apps/server/wrangler.jsonc`.
3. **`access`:** creates the Cloudflare Access for SaaS application and its sign-in policy.
4. **`secrets`:** stores the Worker secrets. Without `--json` or `--yes`, it also offers to store the optional `ANALYTICS_TOKEN` for the Usage page.
5. **`deploy`:** builds the server, applies database migrations, and deploys the Worker.
6. **`owner-token`:** mints a personal access token for the owner, unless setup already minted one that's still valid.
7. **`selftest`:** checks `/healthz` and the OIDC discovery document. When this run minted a token, it also publishes the Welcome artifact over MCP and checks that its content is served.
8. **`agent-config`:** prints the MCP URL and config snippets.

## Cloudflare Access permissions

The token from `wrangler login` may not be able to manage Zero Trust (Access). If it can't, the `access` step asks for an API token with Access: Apps and Policies Edit, Access: Organizations Read, and Zone: DNS Read, and links to a pre-filled form for creating one. Set it as `OA_ACCESS_TOKEN`; in an interactive run, you can paste it at the prompt instead. Setup doesn't keep it. Later runs skip re-checking Access without it, unless the app host or account changes. If the account has no Zero Trust organization yet, setup links to the Zero Trust dashboard to turn it on. Zero Trust's free plan is enough.
