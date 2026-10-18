# Staging

Public (no Access gate). Worker `open-artifacts-staging`; hosts `staging.open-artifacts.com`, `staging-content.open-artifacts.com`. `ENVIRONMENT=production` (never dev mode).

## Resources (no secrets)

| Resource | Name | Id |
|---|---|---|
| Account | | 26ac346086d4405f7a976d48747a2a75 |
| D1 | open-artifacts-staging | 5155e2d4-d9bf-4900-b4ab-1febd480377a |
| R2 | open-artifacts-staging | (by name) |
| KV (binding `OAUTH_KV`) | open-artifacts-staging-oauth | 886a49c875024e8ab5262928d75f85b7 |

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
