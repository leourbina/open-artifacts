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

## B4 Access setup

`ops-staging-access.yml` (manual only) runs `scripts/ops/staging-access.ts`. It is idempotent: a re-run creates and changes nothing that already exists.

```sh
gh workflow run ops-staging-access.yml                       # defaults: team_name=leourbina, force_rotate=false
gh workflow run ops-staging-access.yml -f force_rotate=true  # regenerate SESSION_SECRET + CONTENT_SIGNING_KEY
```

It reads the team domain from the Access organization (falls back to `<team_name>.cloudflareaccess.com`), ensures the reusable allow policy `open-artifacts-staging-owner` (email `me@leourbina.com`), ensures the Access for SaaS OIDC app `open-artifacts-staging` (redirect `https://staging.open-artifacts.com/auth/callback`, scopes openid/email/profile, grant `authorization_code_with_pkce` with `allow_pkce_without_client_secret: false`), and sets the missing Worker secrets `ACCESS_CLIENT_SECRET`, `SESSION_SECRET`, `CONTENT_SIGNING_KEY`, `CF_ACCOUNT_ID`.

The OIDC client secret is only returned when the app is created, and there's no API to rotate it. If the app exists but `ACCESS_CLIENT_SECRET` is missing on the Worker, the run fails. To recover, delete the Access app and re-run. If the app exists but isn't linked to `open-artifacts-staging-owner`, the run also fails: attach the policy in the dashboard, or delete the app and re-run. Everything is preflighted (secret list, policy, generated values) before the app is created. If any Worker secret write fails after creation, the new app is deleted so a re-run starts clean.

**Afterwards:** copy `ACCESS_CLIENT_ID` from the job summary into `env.staging.vars.ACCESS_CLIENT_ID` in `apps/server/wrangler.staging.jsonc` and commit it. Deploys overwrite vars, so it has to live in the config.

### Access app (created 2026-10-18)

| Item | Value |
|---|---|
| Access app name | open-artifacts-staging |
| Access app id | bbdd007c-886a-46db-8c9a-15b0d2f5cc3c |
| Policy | open-artifacts-staging-owner (`fc52c743-e814-448e-97c8-43a6037e5486`) |
| OIDC client id (`ACCESS_CLIENT_ID`) | e332570b66c35883120a21ccfe376f6394aa4089c08cb73c6224b96fab1da7e2 |

The client id is public and is committed in `wrangler.staging.jsonc`. The client secret is a Worker secret and is not recorded here.
