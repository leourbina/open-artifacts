# Staging

Public (no Access gate). Worker `open-artifacts-staging`; hosts `staging.open-artifacts.com`, `staging-content.open-artifacts.com`. `ENVIRONMENT=production` (never dev mode).

## Resources (no secrets)

| Resource | Name | Id |
|---|---|---|
| Account | | 26ac346086d4405f7a976d48747a2a75 |
| D1 | open-artifacts-staging | 5155e2d4-d9bf-4900-b4ab-1febd480377a |
| R2 | open-artifacts-staging | (by name) |
| KV (binding `OAUTH_KV`) | open-artifacts-staging-oauth | 886a49c875024e8ab5262928d75f85b7 |

Zero Trust team: `leourbina`; team domain: `leourbina.cloudflareaccess.com`.

Config: `apps/server/wrangler.staging.jsonc` (`env.staging`).

## Recreate

```sh
cd apps/server
pnpm exec wrangler d1 create open-artifacts-staging
pnpm exec wrangler r2 bucket create open-artifacts-staging
pnpm exec wrangler kv namespace create open-artifacts-staging-oauth
```

Put the new ids into `wrangler.staging.jsonc`, then deploy once.

## GitHub secrets

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (required); `STAGING_OWNER_PAT` (optional, smoke tests).

## Deploy

`deploy-staging.yml` on push to `main`: build, migrate, deploy, smoke. Manual:
`pnpm --filter @oa/server exec wrangler deploy -c wrangler.staging.jsonc --env staging`.

## Repo settings

Enable Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests" (needed by release-please). Release PRs made with `GITHUB_TOKEN` don't trigger CI, so `release-please.yml` dispatches `ci.yml` on the release branch via `workflow_dispatch`.

## Releases

`release-please.yml` keeps a release PR open and dispatches `ci.yml` on its branch after every push to main (GITHUB_TOKEN pushes don't trigger CI on their own).

1. Merge the release PR when it is green and up to date.
2. If it is behind, run `gh pr update-branch <n>`; a user push triggers CI normally.
3. The landing deploy runs after the release and is gated by `check-landing-dist`.
4. To redeploy the landing site: `gh workflow run release-please.yml -f tag=vX.Y.Z`.

## B4 Access setup

`ops-staging-access.yml` (manual only, main only) shares the `staging` concurrency group with `deploy-staging.yml`, so the two never race on Worker secrets. It runs `scripts/ops/staging-access.ts`. It is idempotent: a re-run creates and changes nothing that already exists.

```sh
gh workflow run ops-staging-access.yml                       # defaults: team_name=leourbina, force_rotate=false
gh workflow run ops-staging-access.yml -f force_rotate=true  # regenerate SESSION_SECRET + CONTENT_SIGNING_KEY
```

It reads the team domain from the Access organization, falling back to `<team_name>.cloudflareaccess.com`. It ensures the Access for SaaS OIDC app `open-artifacts-staging`: redirect `https://staging.open-artifacts.com/auth/callback`, scopes openid/email/profile, grant `authorization_code_with_pkce` with `allow_pkce_without_client_secret: false`. Then it sets any missing Worker secrets: `ACCESS_CLIENT_SECRET`, `SESSION_SECRET`, `CONTENT_SIGNING_KEY`. `CF_ACCOUNT_ID` is a plain var in `wrangler.staging.jsonc` (not sensitive, never a secret); a var and a secret with the same name make `wrangler deploy` fail, so `deploy-staging.yml` deletes any Worker secret that shares a name with a staging var (`scripts/ops/conflicting-secrets.ts`) right before deploying.

Policy: the reusable allow policy `Open Artifacts – everyone` uses `include: [{ everyone: {} }]` with no exclude or require (spec 6.5). Access authenticates everyone, and the app does authorization. The script reconciles this policy in place with `PUT /accounts/{id}/access/policies/{policy_id}`:
- A legacy `open-artifacts-staging-owner` policy is renamed. Its id stays the same, so the app's link still works.
- A policy that has drifted is put back to the spec: decision, include, exclude or require, or any of approval_required, isolation_required or purpose_justification_required set. `session_duration` is carried over.
- The policy is created only if neither name exists.

The log prints `policy …: reconciled|unchanged|created`. The app itself is never PUT.

The OIDC client secret is only returned when the app is created, and there's no API to rotate it. If the app exists but `ACCESS_CLIENT_SECRET` is missing on the Worker, the run fails. To recover, delete the Access app and re-run. If the app exists but isn't linked to `Open Artifacts – everyone`, the run also fails: attach the policy in the dashboard, or delete the app and re-run. Everything is preflighted (secret list, policy, generated values) before the app is created. If any Worker secret write fails after creation, the new app is deleted so a re-run starts clean.

**Afterwards:** copy `ACCESS_CLIENT_ID` from the job summary into `env.staging.vars.ACCESS_CLIENT_ID` in `apps/server/wrangler.staging.jsonc` and commit it. Deploys overwrite vars, so it has to live in the config.

### Access app (created 2026-10-18)

| Item | Value |
|---|---|
| Access app name | open-artifacts-staging |
| Access app id | bbdd007c-886a-46db-8c9a-15b0d2f5cc3c |
| Policy | Open Artifacts – everyone (`fc52c743-e814-448e-97c8-43a6037e5486`, formerly open-artifacts-staging-owner) |
| OIDC client id (`ACCESS_CLIENT_ID`) | e332570b66c35883120a21ccfe376f6394aa4089c08cb73c6224b96fab1da7e2 |

The client id is public and is committed in `wrangler.staging.jsonc`. The client secret is a Worker secret and is not recorded here.

## Production token

Production (`artifacts.leourbina.com`, zone `leourbina.com`) uses its own repo secret, **`PROD_CLOUDFLARE_API_TOKEN`**. Staging keeps `CLOUDFLARE_API_TOKEN`. They must never cross: only workflows with `prod` in the filename may reference the PROD secret, and they must not reference `CLOUDFLARE_API_TOKEN` (enforced in `scripts/check-ci.test.ts`). The account id still comes from `CLOUDFLARE_ACCOUNT_ID`.

Scopes (account-scoped, zone `leourbina.com` only):

- Workers Scripts, KV, R2 and D1: Edit
- Access Apps: Edit
- Access Organizations: Read
- Account Analytics: Read
- Workers Routes and DNS on the zone: Edit

Check the token (read-only API calls, prints pass/fail per check and names any missing permission):

```
gh workflow run ops-prod-token-check.yml
```

It runs only on `main`, in the `prod` concurrency group, via `scripts/ops/check-prod-token.sh`.

## First production install

One-time install of the production instance with `@oa/setup --ci`. Runs only on `main`, in the `prod` concurrency group and `production` environment, and only for the latest stable (non-pre-release) tag:

```
gh workflow run ops-prod-install.yml -f tag=vX.Y.Z
```

The workflow checks out the tag and runs `scripts/ci/prod-install.sh --ci`, which logs each JSON line from setup and writes a step/status table to the job summary. It fails on any `error` or `action_required` line.

The owner PAT is never printed: `--ci` uses it only for the selftest and revokes it at the end, and the script aborts if any output line matches the token pattern. After the install, create your own tokens in the dashboard.
