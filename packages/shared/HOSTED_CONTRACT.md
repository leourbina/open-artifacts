# Hosted M1 contract (index)

The one contract P2 (sign-in), P3 (spaces and RBAC) and P4 (UI) cite. Source:
`src/hosted/*.ts` (re-exported from `@oa/shared`), the hosted additions in
`schemas.ts`, `routes.ts` and `errors.ts`, and the mocks in `src/mocks/hosted.ts`.
Every change to an existing shape is optional and appended last, so older
servers parse and `json-shapes.snapshot.test.ts` stays byte-identical with
hosted off.

## Ground rules

- **The SPA owns sign-in.** The chooser and code forms live at `SIGN_IN_PAGE`
  (`/sign-in`). The server is JSON-only; a refused redirect sign-in lands on
  `/sign-in?error=<SignInError>&next=…`.
- **No access is 404**, never 403. The exceptions are explicit codes:
  `space_forbidden` (403) on publish or move into a space the caller can't
  publish to, `turnstile_failed`, `csrf`, `capability_denied`.
- **Lists are cursor pages** (`Page<T>` = `{ items, nextCursor }`) when unbounded:
  spaces, space members, directory groups, audit. Bounded lists are arrays:
  members, mappings, restricted groups.
- **Identity linking** is `identities(provider = "google", subject)`; the
  Google sign-in `sub` equals `DirUser.id`. No shape carries `users.directory_id`.
- **`instance.hosted` exists once**, on `Me.instance`.
- **Query and publish extensions are separate schemas** for now
  (`HostedListQuerySchema`, `HostedSearchQuerySchema`, `HostedPublishInputSchema`).
  `ListQuerySchema`, `SearchQuerySchema` and `PublishInputSchema` also define
  the MCP tool inputs and the generated skill, so P3 folds the extensions in,
  and regenerates the skill, in the PR that implements them.

## FEATURES flags (`FeatureFlagSchema`, env `FEATURES`, `Me.instance.features`)

Comma list set per tier by provisioning; self-hosted default empty = today's
behaviour. `parseFeatures(raw)` drops unknown entries. Reconciles P3's
`sync:google`/`sync:frozen`/`guests-read-only`/`content-revocation` to snake case.

| Flag | Meaning |
|---|---|
| `spaces` | Spaces and roles on; space routes 404 without it (authz identical either way) |
| `sync_google` | Directory sync running |
| `sync_frozen` | Team after trial: synced rows kept (`source: "sync"`), edited by hand, replaced on return to Business |
| `guests_read_only` | Guests capped at viewer, no data writes |
| `content_revocation` | Content URLs check user status and space `publicLinks` in D1 |
| `usage_off` | Hosted: the Usage page and `R.usage` are 404 |

## Shared building blocks (`hosted/core.ts`)

| Name | Meaning |
|---|---|
| `AccessLevelSchema` (CHANGED) | `owner \| editor \| viewer \| manager`. `owner` = personal owner only; `manager` = space manager on a shared-space artifact (owner's actions minus transfer) |
| `RoleSchema` (unchanged) | Org role `owner \| admin \| member \| guest` |
| `SpaceRoleSchema` | `viewer \| editor \| manager` in one space |
| `SpaceKindSchema` | `personal \| shared`; personal space id = user id |
| `SpaceRefSchema` | `{ id, kind, name, publicLinks }` on summaries |
| `MySpaceSchema` | `SpaceRef + myRole` (Me.spaces) |
| `MemberStatusSchema` | `active \| suspended \| removed` |
| `IdentityProviderSchema` | `google` (Member.identities) |
| `CapReasonSchema` | `guest \| restricted`: why access is capped at viewer |
| `TierSchema` | `trial \| team \| business` (null = self-hosted) |
| `DirectoryModeSchema` | `off \| google \| frozen` |
| `InstanceDirectorySchema` | `{ mode, healthy, unhealthySince, banner, tokensUnverified }`. `banner`: unhealthy ≥ 1 h (owner/admin only). `tokensUnverified`: true while unhealthy, since PATs and MCP grants aren't capped at 24 h |
| `InstanceSignInSchema` | `{ mode: access \| direct, providers: (access \| google \| email)[] }` |
| `AuthMethodSchema` | `access \| google \| code \| pat \| oauth \| dev \| test` |
| `MeAuthSchema` | `{ method, readOnly, cap, expiresAt }` |
| `ArtifactCanSchema`, `ARTIFACT_ACTIONS` | `{ edit, share, setVisibility, delete, transfer, move, dataWrite }` |
| `artifactCan(level, { personal, cap })` | The P3 action table as one function (server and mocks). `dataWrite` is false for guests and restricted members; ordinary viewers keep it (the artifact still needs the `db`/`storage` capability) |

## CHANGED existing shapes (all fields optional, appended last)

| Shape | Added |
|---|---|
| `ArtifactSummary` (so `SearchHit`) | `space?: SpaceRef`, `can?: ArtifactCan` |
| `Member` | `status?: MemberStatus` (absent = active), `identities?: ("google")[]` |
| `Me.instance` | `hosted?`, `tier?`, `signIn?`, `features?: FeatureFlag[]`, `directory?: InstanceDirectory` |
| `Me` | `auth?: MeAuth`, `personalSpaceId?` (= user.id), `spaces?: MySpace[]` (shared, by name, ≤ 200) |
| `ERROR_CODES` / `STATUS_FOR` | the codes below |

## Sign-in (`hosted/auth.ts`, P2)

| Route | Contract |
|---|---|
| `GET AUTH.providers` `/auth/providers` | `AuthProviders` (public, no-store, no D1) |
| `GET AUTH.loginGoogle` `/auth/login/google?next` | 302 to Google or the broker; 404 when Google is off |
| `GET AUTH.callbackGoogle` `/auth/callback/google` | 302 `next`; or `SIGN_IN_PAGE?error=SignInError&next` |
| `POST AUTH.codeRequest` `/auth/code/request` | `CodeRequest` → 202 `CodeRequested` |
| `POST AUTH.codeVerify` `/auth/code/verify` | `CodeVerify` → 200 `CodeVerified` |
| `DELETE R.memberIdentity(id, "google")` | 204; owner/admin reset a member's Google link (never the owner's) |

| Schema | Meaning |
|---|---|
| `AuthProvidersSchema` | `{ mode, providers: (access{start} \| google{start, domains} \| email{domainCodes, guests, turnstileSiteKey?})[] }`; only fully configured providers; `turnstileSiteKey` whenever Turnstile is configured |
| `SignInErrorSchema` | `tenant \| identity_conflict \| removed \| no_access \| expired \| failed` |
| `CODE_POLICY` | `{ length: 8, ttlSec: 600, resendAfterSec: 60, maxAttempts: 5 }` |
| `CodeRequestSchema` | `{ email, next?, turnstileToken? }` |
| `CodeRequestedSchema` | `{ maskedEmail, expiresIn, resendAfter, codeLength }`; same 202 for every well-formed address, and when the email pool is full (the pool never 429s) |
| `TurnstileRequiredDetailsSchema` | 400 `turnstile_required` details `{ field: "turnstile", required: true }` |
| `CodeRateLimitedDetailsSchema` | 429 `rate_limited` details `{ retryAfter, scope: email \| ip }` |
| `CodeVerifySchema`, `normalizeCode` | `{ code }`; whitespace and hyphens stripped, then 8 digits |
| `CodeVerifiedSchema` | `{ next, user: Member, readOnly }` |
| `CodeVerifyFailureDetailsSchema` | 401 details: `invalid_code{attemptsLeft} \| expired \| no_pending`; 429 when locked |
| `SessionPayload` (type, reference) | `{ uid, exp, iat, p: access \| google \| code \| dev \| test, t?, e }` |

## Spaces (`hosted/spaces.ts`, P3)

| Route | Body → response | Who |
|---|---|---|
| `GET R.spaces` | `SpacesQuery` → `Page<Space>` | signed in (org admins also see every shared space, `myRole: null`) |
| `POST R.spaces` | `SpaceCreate` → 201 `Space` | org owner, admin |
| `GET R.space(id)` | → `Space` | member, org admin |
| `PATCH R.space(id)` | `SpacePatch` → `Space` | `name`, `publicLinks`: space manager or org admin (`publicLinks` audited; off rewrites public artifacts to team and closes sockets). `allMembersRole`, `outsideSharing`: org admin |
| `DELETE R.space(id)` | 204; 409 `space_not_empty` | org owner, admin |
| `GET R.spaceMembers(id)` | → `Page<SpaceMember>` | member, org admin |
| `PUT R.spaceMember(id, userId)` | `SpaceMemberPut` → `SpaceMember` | space manager, org admin |
| `DELETE R.spaceMember(id, userId)` | 204 (manual row only) | space manager, org admin |
| `GET R.spaceMappings(id)` | → `GroupMapping[]` | org admin |
| `PUT/DELETE R.spaceMapping(id, group)` | `GroupMappingPut` → `GroupMapping` / 204; 409 `directory_sync_off` | org admin |
| `GET R.restrictedGroups` | → `RestrictedGroup[]` | org admin |
| `PUT/DELETE R.restrictedGroup(group)` | (no body) → `RestrictedGroup` / 204; 409 `directory_sync_off` | org admin |

Personal spaces are never created, patched, deleted or given members here: 400 `space_personal`.

| Schema | Meaning |
|---|---|
| `SpaceSchema` | `SpaceRef + { owner, allMembersRole, outsideSharing, myRole, memberCount, artifactCount, createdAt }` |
| `SpacesQuerySchema` | `{ kind?, cursor?, limit? }` |
| `SpaceCreateSchema` / `SpacePatchSchema` | `{ name, allMembersRole, publicLinks, outsideSharing }` (patch: partial); `SPACE_MANAGER_FIELDS` = name, publicLinks |
| `SpaceMemberSchema` | userId-keyed: `{ userId, user, status, role, source: manual \| sync, manualRole, syncRole, groups, cap }` |
| `SpaceMemberPutSchema` | `{ role }` |
| `GroupMappingSchema` / `GroupMappingPutSchema` | `{ group, name, role, memberCount, lastSyncedAt }` / `{ role }` |
| `RestrictedGroupSchema` | The restricted-group cap: members are viewer everywhere, no `allMembersRole`, no create (personal space included), no data writes, on REST, MCP and the data API |

## Artifacts, move and transfer (`hosted/artifacts.ts`, P3)

| Route | Body → response | Rules |
|---|---|---|
| `GET R.artifacts` | `HostedListQuery` | `scope` adds `space` (needs `spaceId`) and `spaces`; `mine` = personal space; `spaceId` narrows any scope |
| `GET R.search` | `HostedSearchQuery` | optional `spaceId` |
| `POST R.artifacts` | `HostedPublishInput` | `spaceId` on create only (existing id: 400 `use_move`); default personal space; not allowed: 403 `space_forbidden` (also any create by a capped caller) |
| `POST R.moveArtifact(id)` | `MoveArtifactInput {spaceId}` → `ArtifactSummary` | manager/owner on the artifact (else 404); shared target only (400 `space_personal`); editor+ in target (else 403 `space_forbidden`) |
| `POST R.transferArtifact(id)` | `TransferArtifactInput {userId}` → `ArtifactSummary` | personal owner only (else 404); successor active non-guest (400 `invalid_successor`); former owner keeps an editor share |
| `GET R.members?status=` | `MembersQuery` → `Member[]` | comma list, default `active`; other statuses org owner/admin |
| `GET R.memberTransfer(id)` | → `TransferSummary {live, deleted}` | counts only; org owner, admin |
| `POST R.memberTransfer(id)` | `TransferInput {to: user\|space, cursor?}` → `TransferResult {moved, remaining, nextCursor}` | 409 `member_active`; ≤ `TRANSFER_PAGE` (100) per call; repeat with `cursor` until `nextCursor` is null |

## Directory and audit (`hosted/directory.ts`, P3)

| Route | Response | Who |
|---|---|---|
| `GET R.directory` | `SyncStatus` | org owner, admin |
| `DELETE R.directory` | 204 (disconnect; memberships freeze) | org owner |
| `GET R.directoryGroups` | `DirectoryGroupsQuery` → `Page<DirectoryGroup>` (group picker) | org admin |
| `GET R.directoryConnect` | 302 to Google consent | org owner |
| `GET R.directoryCallback` | 302 `/settings/directory?connected=1` or `?error=DirectoryConnectError` | OAuth |
| `POST R.directorySync` | 202 `SyncStatus` ("Sync now") | org owner |
| `POST R.directoryHeldConfirm(group)` | 202 `SyncStatus` | org owner |
| `GET R.audit` / `R.auditExport` | `Page<AuditEvent>` / NDJSON | org owner, admin |

Break-glass: a stale org owner reaches only the directory status, connect and
sync routes, after a fresh Google sign-in (10 min); else 401 `reauth_required`.

| Schema | Meaning |
|---|---|
| `SyncStatusSchema` | `{ mode, binding, healthy, state, unhealthySince, lastSuccessAt, lastError, nextRunAt, staleAt, alertedAt, customerMismatch, held }` |
| `DirectoryBindingSchema` | `{ provider, customerId, domain, connectedBy, connectedAt }` |
| `HeldSweepSchema` | `{ group, wouldRemove, members, since }` |
| `DirUserSchema` | `{ id (= Google sub), primaryEmail, suspended, deleted }` |
| `DirectoryGroupSchema` | `{ email, name, memberCount }` |
| `DirectoryConnectErrorSchema` | `not_super_admin \| domain_mismatch \| customer_mismatch \| scopes \| denied \| expired \| failed` |
| `AuditReasonSchema` | why a status changed: `directory_suspend \| directory_unsuspend \| directory_delete \| directory_new_id \| directory_stale \| admin_suspend \| admin_remove \| admin_restore` |
| `AuditActionSchema`, `AuditEventSchema` | audited actions (incl. sign-in, share, visibility, public links, admin self-add, break-glass) and the event row |

## Error codes (appended to `ERROR_CODES`)

| Code | Status | Meaning |
|---|---|---|
| `space_forbidden` | 403 | publish or move into a space you can't publish to; any create by a capped caller |
| `space_personal` | 400 | a personal space as a move/transfer target or a spaces-route target |
| `space_not_empty` | 409 | delete a space that still holds artifacts (trash counts) |
| `use_move` | 400 | `spaceId` on publish to an existing artifact |
| `invalid_successor` | 400 | transfer target isn't an active non-guest member |
| `member_active` | 409 | departed-person transfer on an active member |
| `directory_sync_off` | 409 | mapping or restricted-group change while sync is off or frozen (also Sync now) |
| `turnstile_required` | 400 | code request with no Turnstile token while Turnstile is configured |
| `turnstile_failed` | 403 | Turnstile token rejected |
| `reauth_required` | 401 | break-glass routes need a fresh Google sign-in |

## Test hooks (`hosted/test-hooks.ts`, types only)

| Name | Meaning |
|---|---|
| `TEST_HOOKS` | paths `/__test/session`, `/__test/otp/latest`, `/__test/oauth-client` |
| `TestSessionInputSchema` / `TestSessionResultSchema` | `{ email, role, spaces?: {spaceId, role}[] }` → `{ cookie }` |
| `OtpLatestInputSchema` / `OtpLatestResultSchema` | `{ email }` → `{ code }` (404 when none) |
| `OAuthClientHookResultSchema` | `{ clientId, accessToken }` |
| `HealthzSchema` | `/healthz` `{ ok, plan, version, testHooks? }` |
| `TEST_HOOKS_ALLOWED` | **build-time guard**: false unless the bundler defines `__OA_TEST_HOOKS_ALLOWED__` as true (test and staging wrangler `define` only). Hosted prod builds never define it, so hooks need this AND `TEST_HOOKS=1` with a 32+ char key |

## Mocks (`@oa/shared/mocks`)

`createHandlers({ hosted: true | HostedMockOptions })`, off by default (existing
FE tests unchanged). Options: `mode`, `providers`, `turnstile`, `tier`,
`directory`, `unhealthy`, `features`. Store: personal space per member,
Engineering (caller manager, "Meeting notes" lives there), Exec (caller viewer,
publicLinks off), Clients (admin view); a suspended member Carol with
`{ live: 2, deleted: 1 }` to transfer; a held sweep; `can` from `artifactCan`
on every request. Code flow: `HOSTED_MOCK_CODE` (`24681357`) verifies the last
requested address; 5 wrong tries expire it; 6+ requests per address 429.
Verify signs the mock in as that address (member for `MOCK_DOMAIN`, else a
read-only guest).
