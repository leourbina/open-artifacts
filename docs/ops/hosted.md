# Hosted (Workers for Platforms)

Planned runbook. The spike below (P1 Task 1) ran on 2026-10-21 in the throwaway namespace
`oa-spike-staging` on the shared account 26ac34…, then was deleted.

## Limits

| Resource | Limit | Consequence |
|---|---|---|
| Scripts per dispatch namespace | **Unlimited** ([WfP limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/limits/), checked 2026-10-21) | No account slot math: the 500-scripts-per-account cap and the "refuse under 50 free" rule applied to plan B only and are gone. Namespace scripts are not listed under `/workers/scripts`. |
| Durable Object namespaces | No WfP limit | One class per install is fine. |
| D1 per account | 50,000 databases, 10 GB each, 1 TB total (raisable) | ~100 installs at the cap. |
| R2 per account | 1,000,000 buckets | No constraint. |
| KV per account | **1,000 namespaces** | **Still caps hosted at ~1,000 installs** (one `OAUTH_KV` each). M2 item (D1-backed shim). |
| Cloudflare API | 1,200 requests / 5 min per token | A create is ~15 calls; upgrade waves must budget. |
| Tags per script | 8 | We set 2 (`<id>`, `v<version>`). |
| Unsupported in user Workers | `caches.default`, `request.cf` (needs trusted mode), gradual deployments | The server uses none of them; every upgrade goes to 100% at once. |
| Rate limiting | `namespace_id` is **account-wide** and unique; `limit` counts per Cloudflare location, so bursts can exceed it; `period` is 10 or 60 | Per-install blocks (`1000000×env + 8×seq`) keep tenants apart. |

## Task 1 spike: results (2026-10-21)

Namespace `oa-spike-staging`, dispatch Worker `oa-s-spike-dispatch` (account script, `dispatch_namespace` binding), real `apps/server` 0.22.0 bundle uploaded as `oa-s-ispike000001`.

| # | Check | Result |
|---|---|---|
| 1 | Dispatch namespaces API | Was 403 ("contact the account manager") on 2026-10-21; now 200 with an empty list. `POST` creates a namespace. WfP is enabled. |
| 2 | `scheduled()` through a namespace binding | **Works.** A tiny user Worker wrote a KV stamp; `env.DISPATCHER.get("spike-user").scheduled({cron, scheduledTime})` ran the handler (KV `scheduled` = `{at, cron:"17 3 * * *"}`). Re-run against the real server script: no throw. Task 7's primary path stands; the signed `/__oa/nightly` route is no longer needed. |
| 3 | Real bundle with every template binding + assets | **Accepted, 27 bindings live**: plain_text vars, `d1`, `r2_bucket`, `kv_namespace`, `durable_object_namespace`, `ratelimit` (`1000008`), `browser`, `send_email`, `assets`, `service` (to an account Worker), `secret_text` ×2. `GET …/settings` lists all of them with the right types. |
| 4 | Assets upload | Session: `POST …/dispatch/namespaces/{ns}/scripts/{name}/assets-upload-session` with `{manifest: {"/path": {hash, size}}}`; **hash is the first 32 hex chars of SHA-256** (64 is rejected: "file hash size of 64 is too large"). Upload `POST …/accounts/{id}/workers/assets/upload?base64=true` (account path, not namespace) with `Authorization: Bearer <session jwt>` and base64 string parts; **202 while buckets remain, 201 with the jwt on the completing bucket**. That jwt goes in `metadata.assets.jwt`. 120 files / 3 buckets. |
| 5 | `keep_assets` without a jwt | **Accepted** (200), assets still served afterwards (`/` → 200, SPA HTML). |
| 6 | Durable Object `new_sqlite_classes` in a namespace | **Works.** Upload with `migrations: {new_tag:"v1", steps:[{new_sqlite_classes:[…]}]}`; then a namespace script instantiated the DO twice and persisted state (`n=1`, `n=2`). |
| 7 | Durable Object migration tag, read back | **Not exposed.** `GET …/scripts/{name}/settings` (account *and* namespace) returns `migration_tag: null` right after a successful migration. Re-uploading a migration that is already applied either 412s with `"expected tag is 'vX'"` (wrong or missing `old_tag`) or 400s with "already depended on by existing Durable Objects". An upload with **no** `migrations` is 200. |
| 8 | `ratelimit` at runtime | **Works** on a namespace script with a custom `namespace_id`: a 3/60 s limiter returned `{success:false}` on the 6th request. Counters are per Cloudflare location, so a client hitting several colos can exceed the limit. |
| 9 | `service` binding from a namespace script to an account Worker | **Works** (called, got the peer's response). P2's broker can use it. |
| 10 | `browser` binding | **Accepted as `type: "browser"`** (as wrangler sends; `browser_rendering` is not needed) and listed as `browser` in settings. Not exercised at runtime (no screenshot route hit). |
| 11 | `send_email` binding | **Accepted**, listed as `EMAIL`. Not exercised: sending needs a verified sender domain for the install's `noreply@<slug>.mail.<app-domain>`. |
| 12 | Script subdomain API on a namespace script | `POST …/dispatch/namespaces/{ns}/scripts/{name}/subdomain` → **405 method_not_allowed**. Namespace scripts have no workers.dev subdomain, so the `{enabled:false, previews_enabled:false}` call is account-target only. |
| 13 | Routing: wildcard DNS + wildcard Worker route | **Works.** Proxied `*` AAAA on `open-artifacts-staging.app` + route `*.open-artifacts-staging.app/*` → the dispatch Worker. Certificate issued without extra steps. Mapped host served the real install (`/healthz` 200 `{ok:true,plan:"paid",version:"0.22.0"}`, `/` 200); an unmapped subdomain got the dispatch Worker's own 404; the apex has no record (needs one for the platform page). |
| 14 | Namespace scripts and the account script list | The 4 spike namespace scripts did **not** appear in `/accounts/{id}/workers/scripts`; only the dispatch Worker did. |

### Rulings

1. **Task 7 uses `DISPATCHER.get(id).scheduled(...)`.** The signed nightly route (plan B) is dropped from M1. Keep the route contract with Backend parked for M2.
2. **Task 4's `doMigrationTag` read has no supported API.** Read it once with the 412 probe (upload with the planned `old_tag`; parse `expected tag is '<tag>'` from the 412) or record it in `installs` on our own uploads and reconcile with the same probe on resume. Either way, an upload whose live tag already equals the target must send **no** `migrations`; a resume after a successful migration otherwise fails (400/412).
3. **Task 4 `scriptSubdomainSettings()` only for `target: "account"`.** Skip it for namespace scripts (405).
4. **Routing is a wildcard route, not per-install Custom Domains.** One proxied `*` record and one `*.open-artifacts-<env>.<tld>/*` route per env pointing at the dispatch Worker; the Workers Custom Domains path (and its DNS Edit permission need) goes away from M1.
5. **Task 3 metadata: `type: "browser"` stands; assets hash is 32 hex chars**; the `assets.jwt` flow is as in row 4.
6. **`/healthz` does not report `installId` yet** (0.22.0 returns `{ok, plan, version}`). The create health check can only confirm version today; Backend's `INSTALL_ID` in healthz (Task 6b) is needed before create can verify identity.
7. **Unproven at runtime:** `send_email` delivery (needs sender onboarding) and `browser` rendering. Both bindings are accepted and bound.

## Runbook skeleton

- Per env: one dispatch namespace (`oa-staging`, `oa-prod`), one dispatch Worker with the `dispatch_namespace` binding, one wildcard DNS record and wildcard route per tenant domain pair, platform D1 + `HOSTS` KV, `BROKER_REGISTRY`, the scheduler.
- Create/upgrade/delete: see `@oa/provision` and the P1 plan tasks 4/5/8.
- Nightly: the scheduler calls `DISPATCHER.get(id).scheduled(...)` for every `active` install, 10 at a time, 25 s each.
- Tokens: per-env provisioning token (Workers Admin + KV/R2/D1 Edit account-wide) and per-env zone tokens (Zone Read, DNS Edit, Workers Routes Edit on the env's two zones), each ≤ 30 days and verified before any write.
