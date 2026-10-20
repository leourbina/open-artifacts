# Hosted M1 P4: Spaces in the app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard shows spaces (library, publish, move), gives admins pages to map Google groups to spaces with viewer, editor and manager roles (or manage members by hand) and to connect the Google directory, lets admins transfer a departed person's personal artifacts, and owns the hosted sign-in page (Google plus emailed 8-digit codes), while a self-hosted install looks and behaves exactly as today.

**Architecture:** Hosted features are gated on Backend's optional fields: `me.instance.features.spaces` for spaces, `me.instance.signIn` (signed in) or `GET /auth/providers` (signed out) for sign-in, `me.auth.readOnly` for guests. Edit rights come from the artifact's existing `access` level (`viewer | editor | owner`; a space manager gets `owner`), read through one helper so no component decides them itself. The sign-in UI is the SPA's `/sign-in`; the server renders none. This track edits only `apps/dashboard`: Backend P2/P3 own every `@oa/shared` change (schemas, routes, MSW fixtures and handlers). Task 1 consumes their contract PR; every later UI task is test-first against their mocks; the real suite follows once P2/P3 ship.

**Tech Stack:** React 19, TanStack Router and Query, `@oa/ui` and `@oa/ui/shadcn`, zod, MSW (`@oa/shared/mocks`), vitest plus Testing Library, Playwright (mock config and `playwright.real.config.ts`).

**Spec:** `docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md` on `origin/docs/hosted-design` (PR #350), sections 4.1 (sign-in), 4.2 (RBAC), 4.3, 4.5 (tier rules). Contracts: Backend P2 `docs/superpowers/plans/2026-10-21-hosted-m1-p2-signin.md` v2 (artifact `gGj5GnfYaSKE933f`), section "API contract for P4 (Frontend)"; Backend P3 `docs/superpowers/plans/2026-10-21-hosted-m1-p3-rbac.md` (artifact `d2zZfg3t8fybYZiT`), section "API contract for P4". Roadmap: https://artifacts.leourbina.com/a/axtJ4ieni2LsKfTk (M1, P4).

## Global Constraints

- Copy: no em dashes in any user-facing string; say "any AI agent".
- Self-hosted is unchanged: with `instance.features` absent or `features.spaces: false`, and `/auth/providers` absent or `mode: "access"`, no new control renders and `/sign-in` is today's Access page (existing `e2e/signin-split.spec.ts` stays green unedited).
- Personal artifacts belong to the person: admins can't browse or read them. The UI never lists, links or requests another user's personal space or its artifacts; a transfer shows counts only (`TransferSummary { live, deleted }`).
- Read-only is enforced on the server; the UI must not offer edit, rename, restore, publish-to, move, share or delete to a level that lacks it (read from `artifactCan`, Task 3). Guests (`me.auth.readOnly`) get no publish, edit, share or upload control.
- A tier change never widens access: when `features.directorySync` is not `"google"`, the UI offers no control that adds or changes a group mapping, and copy never implies sync resumes on its own.
- Public no-sign-in links can be turned off per space (`Space.publicLinks`); when off, the UI never offers "public".
- Space roles are exactly `viewer`, `editor`, `manager` (spec 4.2). "All members" is the space's `allMembersRole` (admin-set; `null` = none), never a deletable row.
- The personal space id equals the user id (`me.personalSpaceId === me.user.id`).
- Errors follow Backend's rules: 404 for no access (never 403), 400 `bad_request` for invalid input, 409 `conflict` for state conflicts. The UI shows the server's `message`.
- Sign-in codes are 8 digits, shown `1234 5678`; spaces and hyphens are accepted on input. The UI reads `codeLength`, `expiresIn` and `resendAfter` from the server rather than hard-coding them.
- New fields are optional to the dashboard (older servers omit them), read through Task 1's adapter.
- Boundary: this track never edits `packages/shared` or `apps/server`. A missing or wrong shared shape is a message to Backend, not a local patch.
- Visual choices are Design's: tasks marked **Blocked on D#** start only after the user picks that option. Logic and tests may be written first against a neutral placeholder layout using existing `@oa/ui` primitives.
- No `git stash`. One PR per task (or per small group), through the merge queue.

## Review Focus

1. **A self-hosted instance after upgrade** (spaces off, Access sign-in): nothing new appears and no request goes to `/api/v1/spaces`, `/api/v1/directory` or `/auth/providers` from signed-in pages. Pinned in Task 1 (`me without hosted fields reads as spaces off`) and Task 4 (`spaces off: no spaces request, no switcher`).
2. **A space viewer or a guest opens an artifact**: no rename, restore, publish, move, share or delete anywhere, and a stale tab that tries anyway gets the server's message, not a crash. Pinned in Task 3 (`viewer sees no edit affordance`, `readOnly guest sees no publish control`, `404 on rename toasts`).
3. **An admin handling a departed person**: sees counts, never titles; can't pick the departed person or a guest as successor; a transfer of more than 100 artifacts finishes (cursor loop) and survives a closed dialog mid-way by resuming from the summary. Pinned in Task 12 (`transfer never requests the person's artifacts`, `loops until nextCursor is null`).
4. **Emailed code typos and abuse**: `1234-5678` or `1234 5678` pasted, a wrong code (attempts left shown), an expired code, no pending code (start over), a 429 with `scope: "ip"` vs `"email"`, all with clear copy that never reveals whether the address can sign in. Pinned in Task 13 (`code accepts spaces and hyphens`, `invalid_code shows attempts left`, `expired asks for a new code`, `no_pending starts over`, `429 shows the wait`).
5. **A wrong Google account**: a personal Gmail or another company's Workspace returns to `/sign-in?error=tenant`; the page names the allowed domains from `/auth/providers` and offers Google again. Pinned in Task 13 (`error=tenant names the domains`).

---

## Contracts from Backend

P4 builds against the two Backend sections named in **Spec**. This section records what P4 reads and how; Backend's text is the authority.

**Sign-in (P2 v2), adopted exactly:**
- `GET /auth/providers` (public) -> `AuthProviders { mode: "access" | "direct", providers: ({ id: "access", start } | { id: "google", start, domains: string[] } | { id: "email", domainCodes: boolean, guests: boolean })[] }`; empty `providers` means sign-in isn't set up.
- `GET /auth/login?next=` in direct mode 302s to `/sign-in?next=`. `GET /auth/login/google?next=` starts Google (full-page navigation). The callback returns to `next`, or to `/sign-in?error=tenant|identity_conflict|expired|failed&next=`, or to `/no-access` (unchanged page) when the identity is valid but not admitted.
- `POST /auth/code/request { email, next? }` (JSON, `X-OA-Request: 1`) -> 202 `{ maskedEmail, expiresIn: 600, resendAfter: 60, codeLength: 8 }` for every well-formed address. Resend is the same call. 400 `bad_request` (`details.field: "email"`), 429 `rate_limited` with `Retry-After` and `details { retryAfter, scope: "email" | "ip" }`, 404 when codes are off.
- `POST /auth/code/verify { code }` (email bound server-side by the `__Host-oa_code` cookie) -> 200 `{ next, user: Member, readOnly }`; the UI does `location.assign(next)`. 401 `details.reason`: `invalid_code` (with `attemptsLeft`), `expired`, `no_pending`. 429 = locked (`retryAfter`).
- `Me` gains optional `auth { method: "access" | "google" | "code" | "pat" | "dev" | "test", readOnly, expiresAt }`, `instance.hosted: boolean`, `instance.signIn { mode, providers: ("access" | "google" | "email")[] }`.
- `DELETE /api/v1/members/:id/identities/google` (owner or admin) -> 204; 404 for others or when no link exists.

**RBAC (P3), adopted exactly:**
- Building blocks: `SpaceRole = viewer | editor | manager`, `SpaceKind = personal | shared`, `SpaceRef { id, kind, name }`, `Space` (adds `owner`, `allMembersRole`, `publicLinks`, `outsideSharing`, `myRole` (own personal = `manager`; `null` = admin view only), `memberCount`, `artifactCount`, `createdAt`), `Features { spaces, directorySync: off | google | frozen, guestsReadOnly }`, `MemberStatus = active | suspended | removed`.
- Spaces: `GET R.spaces ?kind=shared&cursor&limit` -> `Page<Space>`; `POST` `SpaceCreate { name, allMembersRole, publicLinks, outsideSharing }` (owner, admin); `GET/PATCH R.space(id)` (`name`: manager or admin; other fields: admin); `DELETE` (409 unless `artifactCount = 0`, trash counts). Personal spaces are not editable here (400).
- Members of a space (by email): `GET R.spaceMembers(id)` -> `Page<SpaceMember { email, user, role, manualRole, syncRole, groups, capped }>`; `PUT/DELETE R.spaceMember(id, email)` `{ role }` (manager or admin); DELETE removes the manual row only.
- Group mappings (org admin): `GET R.spaceMappings(id)` -> `GroupMapping[] { group, name, role, memberCount, lastSyncedAt }`; `PUT/DELETE R.spaceMapping(id, group)` `{ role }`.
- Directory: `GET R.directory` -> `DirectoryStatus { provider, mode: off | active | frozen | auth_failed | backoff, domain, connectedBy, lastSuccessAt, lastError, nextRunAt, held[] }` (owner, admin); `GET R.directoryGroups ?q&cursor` -> `Page<DirectoryGroup { email, name, memberCount }>` (admin, 30 per minute); `GET /api/v1/directory/connect` (owner, 302 to Google); callback returns to `/settings/directory?connected=1` or `?error=`; `POST /api/v1/directory/sync` and `POST /api/v1/directory/held/:group/confirm` (owner, 202 `DirectoryStatus`); `DELETE R.directory` (owner; memberships freeze).
- Artifacts: `ArtifactSummary.space: SpaceRef` (so also `SearchHit`); `owner` is the creator for shared-space artifacts ("Created by"); `access` stays `viewer | editor | owner`, a space manager gets `owner`. `PublishInput.spaceId` (new artifacts only; default personal). `POST R.moveArtifact(id) { spaceId }` -> `ArtifactSummary` (owner level, editor or manager in target, or own personal). `POST R.transferArtifact(id) { userId }` (personal only; leaves the former owner an editor share).
- Departed: `GET R.members ?status=suspended,removed`; `Member.status`; `GET R.memberTransfer(id)` -> `TransferSummary { live, deleted }`; `POST R.memberTransfer(id)` `TransferInput { to: { kind: "user", userId } | { kind: "space", spaceId }, cursor? }` -> `TransferResult { moved (max 100), remaining, nextCursor }`, call again until `nextCursor` is null; 409 if active.
- Lists: `ListQuery.scope` gains `"space"` (needs `spaceId`) and `"spaces"`; `spaceId` narrows other scopes; `"mine"` = my personal space. `SearchQuery.spaceId`.
- Me: `personalSpaceId` (= `user.id`), `spaces: (SpaceRef & { myRole })[]` (shared spaces only, sorted by name, max 200; past that use `GET R.spaces`), `instance.hosted`, `instance.features`.

**Remaining mismatches** (raised with Backend; each task names its fallback):
1. **Manager vs owner (P3 open question 5).** P4 calls the role `manager` everywhere (spec 4.2), and P3's `SpaceRole` agrees, but P3's artifact `access` gives a space manager `owner`. Copy keyed on `access === "owner"` ("You own this") would be wrong for managers. Ask: `access: "manager"`, or keep `owner` and P4 words it by `space.kind === "shared"` (fallback, Task 3).
2. **Mapping writes outside sync.** P3 doesn't say `PUT R.spaceMapping` is refused when `features.directorySync` is `off` or `frozen`. The UI hides the controls (Task 10), but "a tier change never widens access" needs the server to refuse (409). Ask P3 to state it.
3. **No tier in Me.** P3 exposes `features.directorySync` instead of a tier, so Team vs Business copy ("Group sync is part of Business") can't be shown. P4 words by `directorySync` only (fallback); ask only if Design's D6 pick needs the tier.
4. **Identity reset has no read side (P2).** `Member` doesn't say who has a Google link. Ask: `Member.identities?: "google"[]`. Fallback: offer reset on every non-guest member when Google is enabled; 404 means nothing to reset (Task 15).
5. **Space viewers keep live-data writes (P3 open question 3)** while spec 4.2 says contractors are read-only. Not P4's to decide; P4 hides only what the server refuses. Needs the user's call.

**Shared package deliverables** (Backend's contract PR, which P4 Task 1 is blocked on): every schema, type and `R`/`AUTH` route above in `packages/shared`; MSW fixtures (a personal space for the fixture user, `sp_eng` with `myRole: "editor"`, `sp_exec` viewer, `sp_clients` manager with `publicLinks: false`, a removed member with `TransferSummary { live: 12, deleted: 1 }`, artifacts carrying `space`) and stateful handlers for every route (409s, 404s, cursor-paged transfer, code request and verify including `invalid_code`, `expired`, `no_pending`, 429). **A mock switch**: `createHandlers({ hosted?: { signIn: "access" | "direct"; providers?: AuthProviders["providers"]; directorySync: "off" | "google" | "frozen"; spaces: boolean; readOnlyGuest?: boolean } })`. Without `hosted`, `/me` has none of the new fields and `/auth/providers` answers `{ mode: "access", providers: [{ id: "access", start: "/auth/login" }] }`.

## Task order and parallelism

| Task | Depends on | Blocked on Design | Can run in parallel with |
|---|---|---|---|
| 1 Consume contract | Backend contract PR (P2, P3) | none | Design work |
| 2 Hooks | 1 | none | 3 |
| 3 Permissions | 1 | none (D10 optional) | 2 |
| 4 Library filter | 2 | none | 6, 8, 9, 12, 13, 15, 16 |
| 5 Switcher, marker | 4 | D1, D2, D3 | 7, 10 |
| 6 Publish picker | 2 | D4 | 4, 8, 9, 12, 13, 15, 16 |
| 7 Move | 2, 3, 6 | D3, D4 | 5, 10 |
| 8 Public off | 2, 3 | D9 | 4, 6, 9, 12, 13, 15, 16 |
| 9 Spaces admin | 2 | D5, D9 | 4, 6, 8, 12, 13, 15 |
| 10 Group mappings | 9 | D5 | 5, 7 |
| 11 Space members | 10 | D6 | nothing in its file |
| 12 Transfer | 2 | D7 | 4, 6, 8, 9, 13, 16; not 15 (same file) |
| 13 Sign-in page | 2 | D8 | 4, 6, 8, 9, 12, 15, 16 |
| 14 Real e2e | 3 to 13, 15, 16; P2 and P3 merged | none | none |
| 15 Reset Google link | 2 | D11 | 4, 6, 8, 9, 13, 16; not 12 |
| 16 Directory page | 2 | D12 | 4, 6, 8, 12, 13, 15; not 9 (same files) |

Waves: 1; then 2 and 3; then 4, 6, 8, 9, 12, 13, 15, 16; then 5, 7, 10; then 11; then 14. File overlaps to sequence: `router.tsx` (4, 9, 13, 16), `SettingsLayout.tsx` (9, 16), `Library.tsx` (4 then 5), `Details.tsx` (3 then 7), `Share.tsx` (3 then 8), `SpaceAccess.tsx` (10 then 11), `Members.tsx` (12, 15).

## Design options needed

Each is a question for Design, who produce options; the user picks.

- **D1 Space switcher**: where and how a person moves between spaces (sidebar list, library header dropdown, or a tab strip replacing All / Mine / Shared / Team), and how it fits with today's scope tabs.
- **D2 Personal space**: its name ("My space", "Personal", the person's name), icon, and position relative to shared spaces.
- **D3 Space marker**: how an artifact's space shows on cards, rows, the viewer title bar or crumbs, and search hits; "Created by" for shared-space artifacts.
- **D4 Space picker**: the control in Create artifact and Move (select, combobox, or list), what's preselected, and how spaces you can't publish to appear (hidden vs disabled with a reason).
- **D5 Spaces admin page**: layout of `/settings/spaces`, the group-to-role row, adding a group (directory search), and how "All members" (`allMembersRole`) reads.
- **D6 Space members and frozen sync**: the member row (manual vs synced role, groups, the guest "capped" marker), adding a person by email, and the banner when sync is off or frozen.
- **D7 Transfer**: where departed people show (badge on Members rows vs a separate "Departed" card), the dialog (successor person vs a space), and progress for long transfers.
- **D8 Hosted sign-in**: Google button with the allowed domains, the email then 8-digit code two-step (one field vs boxes), masked address, resend timer, expiry, error states for each `error=` and 401 reason, empty "not set up" state, and the hosted brand footer ("Self-hosted on Cloudflare" must not show).
- **D9 Public links off**: how the Share panel shows "public" when the space disallows it (hidden, or disabled with a note), and the space-level toggle.
- **D10 Read-only signal**: whether viewers and guests get an explicit "View only" marker, or simply no edit controls.
- **D11 Reset Google link**: where the admin's "Reset Google sign-in" action sits on a Members row, and its confirmation copy.
- **D12 Directory page**: `/settings/directory` layout: connect state, status (`active`, `frozen`, `auth_failed`, `backoff`), last sync and errors, held sweeps awaiting confirmation, Sync now, Disconnect (with the "memberships freeze" warning).

---

## File Structure

Only `apps/dashboard` changes.

`apps/dashboard/src`
- `api/contract.ts` (create): the one place the dashboard imports hosted shapes from `@oa/shared`; lenient readers for older servers.
- `api/queries.ts` (modify): space, member, mapping, directory, move, transfer and identity hooks and `qk` keys.
- `api/auth.ts` (create): `useAuthProviders`, `requestCode`, `verifyCode` (signed-out calls).
- `auth/permissions.ts` (create): `artifactCan`, `canPublishTo`, `useHosted`.
- `spaces/` (create): `SpacePicker.tsx`, `SpaceSwitcher.tsx`, `SpaceMarker.tsx`, `MoveDialog.tsx`, `useCurrentSpace.ts`.
- `settings/spaces/` (create): `Spaces.tsx` (page), `SpaceAccess.tsx` (mappings and members), `GroupSearch.tsx`.
- `settings/Directory.tsx` (create): directory connection page.
- `settings/Transfer.tsx` (create); `settings/Members.tsx` (modify): departed people, identity reset.
- `pages/SignIn.tsx` (modify): providers, Google, errors; `pages/CodeSignIn.tsx` (create): email then code.
- `library/Library.tsx`, `library/useLibraryQuery.ts`, `library/useSearchQuery.ts`, `router.tsx`, `upload/UploadDialog.tsx`, `upload/uploadPipeline.ts`, `upload/DropZone.tsx`, `viewer/TitleBar.tsx`, `viewer/panels/{Details,Versions,Share}.tsx`, `settings/SettingsLayout.tsx` (modify); `auth/useMe.ts`, `viewer/useOfferUndo.ts` (typecheck against the new shapes in Task 1).

Tests: `apps/dashboard/test/{contract,hosted-queries,permissions,spaces-library,spaces-publish,spaces-move,share-public-off,spaces-admin,space-access,transfer,signin-hosted,reset-identity,directory}.test.tsx`; `apps/dashboard/test/harness.tsx` (modify: `mountHosted`); `apps/dashboard/e2e/{spaces,signin-hosted}.spec.ts` (create), `e2e/m1-a11y.spec.ts`, `e2e/m2-a11y.spec.ts` (modify); `apps/dashboard/e2e/real/spaces.spec.ts` (create), `e2e/real/consent.spec.ts` (modify).

---

### Task 1: Consume Backend's contract (dashboard adapter)

**Depends on:** Backend's contract PR (P3 with P2's sign-in parts) merged to `main`. Blocked until then.

**Files:**
- Create: `apps/dashboard/src/api/contract.ts`
- Modify: `apps/dashboard/test/harness.tsx`
- Test: `apps/dashboard/test/contract.test.ts`

**Interfaces:**
- Consumes: Backend's shared exports and `createHandlers({ hosted })`.
- Produces:
  - `contract.ts` re-exports `Space`, `SpaceRef`, `SpaceRole`, `SpaceKind`, `SpaceMember`, `GroupMapping`, `DirectoryGroup`, `DirectoryStatus`, `Features`, `MemberStatus`, `TransferSummary`, `TransferInput`, `TransferResult`, `AuthProviders`, `CodeRequested`, `CodeVerified`, `SignInError`; `type MySpace = NonNullable<Me["spaces"]>[number]`; `SPACE_ROLES: readonly SpaceRole[]`. No other dashboard file imports these from `@oa/shared` directly.
  - `features(me: Me): Features` -> `me.instance.features ?? { spaces: false, directorySync: "off", guestsReadOnly: false }`.
  - `readAuthProviders(raw: unknown): AuthProviders` -> parsed, else `{ mode: "access", providers: [{ id: "access", start: AUTH.login }] }`.
  - `harness.tsx`: `mountHosted(path: string, hosted: HostedMock)`; `HostedMock` is the `hosted` option of Backend's `createHandlers`.

- [ ] **Step 1: Write the failing tests**

```ts
test("me without hosted fields reads as spaces off", () => {
  expect(features(MeSchema.parse(fixtures.me))).toEqual({ spaces: false, directorySync: "off", guestsReadOnly: false });
});
test("hosted mock me carries spaces, personalSpaceId, features and auth", async () => {
  // createHandlers({ hosted: { signIn: "direct", directorySync: "frozen", spaces: true } })
  // me.personalSpaceId === me.user.id; me.spaces all kind "shared"; features.directorySync === "frozen"; me.auth.method === "google"
});
test("dashboard types line up with the shared schemas", () => {
  expectTypeOf<SpaceRole>().toEqualTypeOf<"viewer" | "editor" | "manager">();
  expectTypeOf<TransferResult>().toMatchTypeOf<{ moved: number; remaining: number; nextCursor: string | null }>();
  expect(SPACE_ROLES).toEqual(["viewer", "editor", "manager"]);
});
test("readAuthProviders falls back to access mode", () => {
  expect(readAuthProviders(undefined).mode).toBe("access");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- contract`
Expected: FAIL, `../src/api/contract` not found.

- [ ] **Step 3: Implement `contract.ts` and `mountHosted`.** If a shape differs from this plan, follow Backend's and update later Interfaces in the same PR; if a needed shape is missing, message Backend and stop.

- [ ] **Step 4: Run the dashboard suites against the new mocks**

Run: `pnpm --filter @oa/dashboard test && pnpm --filter @oa/dashboard typecheck && pnpm --filter @oa/dashboard test:e2e`
Expected: PASS. P3 lists dashboard specs touched by the richer mocks (`cpu-limit`, `embed`, `display-name`, `renav-notice`, `library-layout`, `card-inset`, `invite-link`, `m1-a11y`, `m2-a11y`, `m2-hostile`, `settings-layout`, `share-layout`, `usage-layout`); fix dashboard-side breakage here.

- [ ] **Step 5: Commit** `feat(dashboard): consume Backend's hosted contract`

### Task 2: Query hooks and sign-in calls

**Depends on:** Task 1; uses Backend's mocks.

**Files:**
- Modify: `apps/dashboard/src/api/queries.ts`
- Create: `apps/dashboard/src/api/auth.ts`
- Test: `apps/dashboard/test/hosted-queries.test.tsx`, `apps/dashboard/test/qk.test.ts`

**Interfaces:**
- Consumes: `contract.ts` types; Backend's `R` and `AUTH` routes.
- Produces:
  - `qk.spaces(q)`, `qk.space(id)`, `qk.spaceMembers(id)`, `qk.spaceMappings(id)`, `qk.directory`, `qk.directoryGroups(q)`, `qk.memberTransfer(id)`; all space keys start with `"spaces"`.
  - `useSpaces({ kind?: "shared"; enabled?: boolean })` (infinite, `Page<Space>`), `useSpace(id, { enabled })`, `useCreateSpace()`, `usePatchSpace(id)`, `useDeleteSpace()`, `useSpaceMembers(id)`, `usePutSpaceMember(id)` (`{ email, role }`), `useDeleteSpaceMember(id)`, `useSpaceMappings(id)`, `usePutMapping(id)` (`{ group, role }`), `useDeleteMapping(id)`, `useDirectory()`, `useDirectoryGroups(q)` (enabled at 2+ characters), `useDirectorySync()`, `useConfirmHeld()`, `useDisconnectDirectory()`, `useMoveArtifact(id)`, `useTransferSummary(memberId)`, `useRunTransfer(memberId)` (`mutateAsync(input: TransferInput): Promise<TransferResult>`, one page per call), `useResetIdentity()` (`memberId`).
  - `api/auth.ts`: `useAuthProviders()` (through `readAuthProviders`, `retry: false`), `requestCode(email: string, next?: string): Promise<CodeRequested>`, `verifyCode(code: string): Promise<CodeVerified>`; both send `X-OA-Request: 1` and throw `ApiClientError` with `details` intact.

- [ ] **Step 1: Write the failing tests**

```ts
it("move invalidates the artifact, the library and spaces", ...);
it("mapping failure toasts the server message", ...);           // "Couldn't change access." + description
it("directory search waits for two characters", ...);
it("useRunTransfer posts the cursor it is given", ...);
it("requestCode returns codeLength 8 from the server", async () => {
  expect((await requestCode("b@finqore.com")).codeLength).toBe(8);
});
it("verifyCode keeps 401 details for the caller", ...);          // err.details.reason === "invalid_code", attemptsLeft
it("useAuthProviders treats a 404 as access mode", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- hosted-queries qk`
Expected: FAIL, hooks not exported.

- [ ] **Step 3: Implement the hooks** with `useInvalidating` and the failure titles "Couldn't create the space.", "Couldn't save the space.", "Couldn't delete the space.", "Couldn't change access.", "Couldn't move the artifact.", "Couldn't transfer the artifacts.", "Couldn't reset the sign-in.", "Couldn't start a sync."

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- hosted-queries qk`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(dashboard): hosted query hooks and sign-in calls`

### Task 3: One permission helper; viewers and guests never see edit

**Depends on:** Task 1; uses Backend's mocks.

**Files:**
- Create: `apps/dashboard/src/auth/permissions.ts`
- Modify: `apps/dashboard/src/viewer/TitleBar.tsx:142-143`, `viewer/panels/Details.tsx:29-30`, `viewer/panels/Versions.tsx:22`, `viewer/panels/Share.tsx:109`, `upload/DropZone.tsx:35`, `library/Library.tsx` (DropZone `allowed`)
- Test: `apps/dashboard/test/permissions.test.tsx`

**Interfaces:**
- Produces:
  - `artifactCan(a: ArtifactSummary): { edit: boolean; share: boolean; move: boolean; delete: boolean; managerNotOwner: boolean }`: `edit = access !== "viewer"`; `share = move = delete = access === "owner"`; `managerNotOwner = access === "owner" && a.space?.kind === "shared"` (mismatch 1 fallback: copy says "Manager", never "You own this").
  - `canPublishTo(s: { kind: SpaceKind; myRole: SpaceRole | null }): boolean` -> `kind === "personal" || myRole === "editor" || myRole === "manager"`.
  - `useHosted(): { features: Features; spaces: MySpace[]; personalSpaceId: string | null; readOnly: boolean; signIn: Me["instance"]["signIn"] | null }` from `useMe` (`readOnly = me.auth?.readOnly ?? false`).

- [ ] **Step 1: Write the failing tests**

```ts
it("access maps to rights", () => {
  expect(artifactCan({ ...a, access: "editor" })).toMatchObject({ edit: true, share: false, move: false, delete: false });
});
it("viewer sees no edit affordance", ...);          // no Rename, Restore, Publish new version, Delete, Save visibility, Move
it("space manager is never told they own it", ...); // access owner + space shared: no "You own this"; shows Manager
it("readOnly guest sees no publish control", ...);  // me.auth.readOnly: no Create artifact, no drop zone
it("404 on rename toasts the server message and keeps the old title", ...);
it("canPublishTo excludes viewer and roleless spaces", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- permissions`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `permissions.ts` and replace the `access` checks** with `artifactCan`. No visual change beyond the manager wording.

- [ ] **Step 4: Run the full suite**

Run: `pnpm --filter @oa/dashboard test`
Expected: PASS, including `share.test.tsx`, `versions.test.tsx`, `shell.test.tsx`.

- [ ] **Step 5: Commit** `refactor(dashboard): one artifactCan helper; guests read-only`

### Task 4: Library space filter (URL and query plumbing)

**Depends on:** Task 2; uses Backend's mocks.

**Files:**
- Modify: `apps/dashboard/src/router.tsx` (library `validateSearch`), `library/useLibraryQuery.ts`, `library/useSearchQuery.ts`, `library/Library.tsx`
- Create: `apps/dashboard/src/spaces/useCurrentSpace.ts`
- Test: `apps/dashboard/test/spaces-library.test.tsx`

**Interfaces:**
- Consumes: `useHosted`, `useSpace`.
- Produces: library search param `space?: string`; `LibraryFilters.space?: string` sent as `scope=space&spaceId=<id>` (or `scope=mine` when it equals `personalSpaceId`); search sends `spaceId`; `useCurrentSpace(): { space: SpaceRef | null; set(id: string | undefined): void }` (unknown id clears the param; resolves from `me.spaces`, then `useSpace(id)` past 200).

- [ ] **Step 1: Write the failing tests**

```ts
it("spaces off: no spaces request, no switcher", ...);
it("?space=sp_eng requests scope=space&spaceId=sp_eng", ...);
it("?space=<personalSpaceId> requests scope=mine", ...);
it("unknown space id clears the param", ...);
it("search carries spaceId when a space is chosen", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-library`
Expected: FAIL.

- [ ] **Step 3: Implement.** Space queries run only when `features.spaces`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-library library search`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(library): space filter in the URL and query`

### Task 5: Space switcher and space marker

**Depends on:** Task 4; uses Backend's mocks. **Blocked on D1, D2, D3.**

**Files:**
- Create: `apps/dashboard/src/spaces/SpaceSwitcher.tsx`, `spaces/SpaceMarker.tsx`
- Modify: `library/Library.tsx` (or `layout/AppLayout.tsx`, per D1), `library/ArtifactCard.tsx`, `library/ArtifactRow.tsx`, `viewer/TitleBar.tsx` (per D3)
- Test: `apps/dashboard/test/spaces-library.test.tsx`, `apps/dashboard/e2e/spaces.spec.ts`

**Interfaces:**
- Consumes: `useCurrentSpace`, `useHosted().spaces`, `personalSpaceId`.
- Produces: `<SpaceSwitcher />`, `<SpaceMarker space={SpaceRef} />`.

- [ ] **Step 1: Write the failing tests**

```ts
it("switcher lists my personal space first, then me.spaces in server order", ...);
it("switcher never shows another user's personal space", ...);
it("choosing a space navigates to ?space=<id>", ...);
it("shared-space cards say Created by, not Owner", ...);
// e2e/spaces.spec.ts (mock): keyboard reachable; 375 and 1280 widths, light and dark
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-library`
Expected: FAIL.

- [ ] **Step 3: Implement per D1 to D3.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-library && pnpm --filter @oa/dashboard test:e2e -- spaces`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(library): space switcher and space marker`

### Task 6: Pick a space when publishing

**Depends on:** Task 2; uses Backend's mocks. **Blocked on D4.**

**Files:**
- Create: `apps/dashboard/src/spaces/SpacePicker.tsx`
- Modify: `upload/uploadPipeline.ts:15,181`, `upload/UploadDialog.tsx`
- Test: `apps/dashboard/test/spaces-publish.test.tsx`

**Interfaces:**
- Consumes: `useHosted`, `canPublishTo`, `useCurrentSpace`.
- Produces: `uploadArtifact` input gains `spaceId?: string` (sent only for a new artifact, only when set); `<SpacePicker value={string | undefined} onChange={(id: string) => void} filter={(s: MySpace) => boolean} label={string} />` (the personal entry uses `personalSpaceId`).

- [ ] **Step 1: Write the failing tests**

```ts
it("picker offers personal, editor and manager spaces only", ...);
it("preselects the library's current space when publishable, else personal", ...);
it("publish body carries spaceId", ...);
it("spaces off: no picker and no spaceId", ...);
it("404 from publish shows the server message in the dialog", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-publish`
Expected: FAIL.

- [ ] **Step 3: Implement per D4.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-publish upload dropzone`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(upload): choose a space when publishing`

### Task 7: Move an artifact to another space

**Depends on:** Tasks 2, 3, 6; uses Backend's mocks. **Blocked on D3, D4.**

**Files:**
- Create: `apps/dashboard/src/spaces/MoveDialog.tsx`
- Modify: `viewer/panels/Details.tsx`
- Test: `apps/dashboard/test/spaces-move.test.tsx`

**Interfaces:**
- Consumes: `useMoveArtifact`, `useSpace`, `SpacePicker`, `artifactCan`, `canPublishTo`.
- Produces: `<MoveDialog artifact={ArtifactSummary} onClose={() => void} />`.

- [ ] **Step 1: Write the failing tests**

```ts
it("Move shows only when artifactCan(a).move", ...);
it("targets exclude the current space and non-publishable spaces", ...);
it("moving into a public-off space warns that the public link stops working", ...); // target's publicLinks via useSpace
it("after move the panel shows the new space from the response", ...);
it("400 or 409 keeps the dialog open with the server message", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-move`
Expected: FAIL.

- [ ] **Step 3: Implement per D3, D4.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-move`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(viewer): move an artifact to another space`

### Task 8: Public links off per space, in the Share panel

**Depends on:** Tasks 2, 3; uses Backend's mocks. **Blocked on D9.**

**Files:**
- Modify: `apps/dashboard/src/viewer/panels/Share.tsx:36-60,207-260`
- Test: `apps/dashboard/test/share-public-off.test.tsx`

**Interfaces:**
- Consumes: `artifact.space`, `useSpace(artifact.space.id, { enabled: artifactCan(a).share && a.space.kind === "shared" })` for `publicLinks` (P3's `SpaceRef` has none; only owners and managers change visibility, and they can read the space).

- [ ] **Step 1: Write the failing tests**

```ts
it("public is not selectable when the space turned public links off", ...);
it("public off: an existing public artifact shows the space note", ...);
it("personal space or self-hosted: Share panel unchanged and no space request", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- share-public-off`
Expected: FAIL.

- [ ] **Step 3: Implement per D9.** Proposed note: "Public links are turned off for this space."

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- share-public-off share`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(share): respect a space's public-links setting`

### Task 9: Spaces admin page

**Depends on:** Task 2; uses Backend's mocks. **Blocked on D5, D9.**

**Files:**
- Create: `apps/dashboard/src/settings/spaces/Spaces.tsx`
- Modify: `router.tsx` (`gated("/settings/spaces", ADMINS, "/settings/agents", Spaces)`), `settings/SettingsLayout.tsx` (tab "Spaces", owner and admin, only when `features.spaces`)
- Test: `apps/dashboard/test/spaces-admin.test.tsx`

**Interfaces:**
- Consumes: `useSpaces({ kind: "shared" })`, `useCreateSpace`, `usePatchSpace`, `useDeleteSpace`, `SettingsCard`, `MEASURE`.
- Produces: route `/settings/spaces`; hosts `<SpaceAccess space={Space} />` (Tasks 10, 11) for the selected space.

- [ ] **Step 1: Write the failing tests**

```ts
it("members and guests are redirected away", ...);
it("tab hidden and route redirects when spaces are off", ...);
it("lists shared spaces only, paging with cursor", ...);
it("create sends name, allMembersRole, publicLinks", ...);
it("All members role PATCHes allMembersRole; None sends null", ...);
it("delete non-empty space shows the 409 message", ...);
it("public links toggle PATCHes publicLinks", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-admin`
Expected: FAIL.

- [ ] **Step 3: Implement per D5, D9.** Delete confirms through `AlertDialog`; the server's 409 is the authority.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-admin router`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): spaces admin page`

### Task 10: Map Google groups to space roles

**Depends on:** Task 9; uses Backend's mocks. **Blocked on D5.**

**Files:**
- Create: `apps/dashboard/src/settings/spaces/SpaceAccess.tsx`, `settings/spaces/GroupSearch.tsx`
- Test: `apps/dashboard/test/space-access.test.tsx`

**Interfaces:**
- Consumes: `useSpaceMappings`, `usePutMapping`, `useDeleteMapping`, `useDirectoryGroups`, `useHosted().features.directorySync`.
- Produces: `<SpaceAccess space={Space} />`; `<GroupSearch onPick={(g: DirectoryGroup) => void} exclude={string[]} />` (group emails).

- [ ] **Step 1: Write the failing tests**

```ts
it("role choices are exactly Viewer, Editor, Manager", ...);
it("adding a group PUTs its role; mapped groups are excluded from search", ...);
it("removing a mapping asks for confirmation then DELETEs", ...);
it("shows member count and last synced per mapping", ...);
it("directorySync off or frozen: no control adds or changes a mapping", ...); // mismatch 2, UI side
it("mappings are hidden from space managers who aren't admins", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: FAIL.

- [ ] **Step 3: Implement per D5.** Role change is optimistic (pattern `useOptimisticMembers`), restored on failure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): map directory groups to space roles`

### Task 11: Space members (manual rows, synced rows, frozen)

**Depends on:** Task 10; uses Backend's mocks. **Blocked on D6.**

**Files:**
- Modify: `apps/dashboard/src/settings/spaces/SpaceAccess.tsx`, `settings/spaces/Spaces.tsx` (managers reach their space's members)
- Test: `apps/dashboard/test/space-access.test.tsx`

**Interfaces:**
- Consumes: `useSpaceMembers`, `usePutSpaceMember`, `useDeleteSpaceMember`, `useMembers` (to pick people by email), `SpaceMember.manualRole | syncRole | groups | capped`.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists effective role with manual and synced sources", ...);
it("add by email PUTs a manual role", ...);
it("synced-only rows offer no remove; removing a manual row says the synced role stays", ...);
it("capped guests show they can only view whatever the role", ...);
it("frozen banner never says sync resumes on its own", ...);
it("a space manager who isn't an admin can add and remove manual members of their space", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: FAIL on the member cases.

- [ ] **Step 3: Implement per D6.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): space members, manual and synced`

### Task 12: Transfer a departed person's personal artifacts

**Depends on:** Task 2; uses Backend's mocks. **Blocked on D7.**

**Files:**
- Create: `apps/dashboard/src/settings/Transfer.tsx`
- Modify: `settings/Members.tsx` (departed people via `?status=suspended,removed`, per D7)
- Test: `apps/dashboard/test/transfer.test.tsx`

**Interfaces:**
- Consumes: `useMembers`, `useTransferSummary`, `useRunTransfer`, `useSpaces({ kind: "shared" })`, `Member.status`.
- Produces: `<TransferDialog member={Member} onClose={() => void} />`; `runAll(run: (i: TransferInput) => Promise<TransferResult>, to: TransferInput["to"], onProgress: (moved: number, remaining: number) => void): Promise<number>` in `Transfer.tsx` (loops while `nextCursor`).

- [ ] **Step 1: Write the failing tests**

```ts
it("suspended and removed members with live + deleted > 0 offer Transfer", ...);
it("active members never offer Transfer", ...);
it("dialog shows the counts, never titles", ...);                 // "12 artifacts, 1 in trash"
it("transfer never requests the person's artifacts", ...);        // no R.artifacts or R.search call
it("successor list excludes the departed, guests and inactive members", ...);
it("loops until nextCursor is null and reports progress", ...);
it("closing mid-way and reopening resumes from the fresh summary", ...);
it("409 for an active member shows the server message", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- transfer`
Expected: FAIL.

- [ ] **Step 3: Implement per D7.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- transfer members`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): transfer a departed person's artifacts`

### Task 13: Hosted sign-in page (Google and emailed codes)

**Depends on:** Task 2; uses Backend's mocks. **Blocked on D8.**

**Files:**
- Modify: `apps/dashboard/src/pages/SignIn.tsx`, `router.tsx:153-155` (pass `error` and `next`), `e2e/m1-a11y.spec.ts`, `e2e/m2-a11y.spec.ts`
- Create: `apps/dashboard/src/pages/CodeSignIn.tsx`, `e2e/signin-hosted.spec.ts`
- Test: `apps/dashboard/test/signin-hosted.test.tsx`

**Interfaces:**
- Consumes: `useAuthProviders`, `requestCode`, `verifyCode`, `SignInError`.
- Produces: `SignIn({ error?: string; next?: string })`; `<CodeSignIn next={string | undefined} />`; `normalizeCode(raw: string, length: number): string | null` (strips whitespace and hyphens; exactly `length` digits, else null).

- [ ] **Step 1: Write the failing tests**

```ts
it("access mode renders today's page unchanged", ...);          // "Continue with Cloudflare Access"
it("direct mode never mentions Cloudflare Access", ...);
it("Google button navigates to its start with next", ...);      // full page, providers[].start
it("error=tenant names the domains", ...);                      // "@finqore.com" from google.domains
it("error=identity_conflict asks for an admin reset", ...);
it("error=expired and error=failed offer to try again", ...);
it("empty providers says sign-in is not set up", ...);
it("code accepts spaces and hyphens", () => {
  expect(normalizeCode(" 1234-5678 ", 8)).toBe("12345678");
  expect(normalizeCode("1234 5678", 8)).toBe("12345678");
  expect(normalizeCode("1234567", 8)).toBeNull();
});
it("request shows maskedEmail, a resend timer from resendAfter and expiry from expiresIn", ...);
it("same screen for any address", ...);                         // 202 always
it("invalid_code shows attempts left and clears the code", ...);
it("expired asks for a new code", ...);
it("no_pending starts over at the email step", ...);
it("429 shows the wait from retryAfter and disables Resend", ...);
it("verify success calls location.assign(next)", ...);
it("no copy contains an em dash", ...);                         // scan rendered text for "—"
// m1-a11y / m2-a11y: axe and keyboard pass for /sign-in in direct mode: providers, code entry, each error state
// e2e/signin-hosted.spec.ts (mock, hosted): 375 and 1280, light and dark; signin-split.spec.ts untouched
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- signin-hosted`
Expected: FAIL.

- [ ] **Step 3: Implement per D8.** Code input: `inputMode="numeric"`, `autoComplete="one-time-code"`, room for `codeLength` digits plus separators; placeholder `1234 5678`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- signin-hosted && pnpm --filter @oa/dashboard test:e2e -- signin a11y`
Expected: PASS: `signin-split`, `signin-hosted`, `m1-a11y`, `m2-a11y`.

- [ ] **Step 5: Commit** `feat(sign-in): hosted Google and emailed-code sign-in`

### Task 14: Real end-to-end suite against a hosted-mode server

**Depends on:** Tasks 3 to 13, 15, 16; Backend P2 and P3 merged.

**Files:**
- Create: `apps/dashboard/e2e/real/spaces.spec.ts`
- Modify: `apps/dashboard/e2e/real/consent.spec.ts` (direct-mode variant), `e2e/real/fixtures.ts` (fixtures `spaceViewer`, `spaceEditor`, `admin` via dev login with hosted config)
- Test: the specs themselves

**Interfaces:**
- Consumes: real server endpoints; Backend's contract.

- [ ] **Step 1: Write the failing tests**

```ts
test("a space viewer sees no edit controls and the API refuses a publish", ...);
test("an admin's spaces and library never show another person's personal artifacts", ...);
test("an editor publishes into a space and moves it to another", ...);
test("public links off: Share can't make it public; /a/<id>/full shows NotPublic", ...);
test("transfer moves a removed person's artifacts to a successor", ...);
test("an invited guest signs in with an 8-digit code and sees no edit controls", ...); // code from P2's test hook inbox
// consent.spec.ts: "direct mode: MCP connector popup signs in through /sign-in and reaches consent"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test:e2e:real -- spaces consent`
Expected: FAIL until the server and UI pieces are in place.

- [ ] **Step 3: Fix any drift**: dashboard-side here; server or shared fixes go to Backend as an issue linked from this PR.

- [ ] **Step 4: Run twice with parallel workers**

Run: `pnpm --filter @oa/dashboard test:e2e:real -- spaces consent --repeat-each=2`
Expected: PASS.

- [ ] **Step 5: Commit** `test(e2e): hosted spaces and direct sign-in on a real server`

### Task 15: Reset a member's Google link

**Depends on:** Task 2; uses Backend's mocks. **Blocked on D11.**

**Files:**
- Modify: `apps/dashboard/src/settings/Members.tsx`
- Test: `apps/dashboard/test/reset-identity.test.tsx`

**Interfaces:**
- Consumes: `useResetIdentity`, `useHosted().signIn.providers` (offered only when `"google"` is enabled), `Member.identities` if Backend adds it (mismatch 4).

- [ ] **Step 1: Write the failing tests**

```ts
it("admins see Reset Google sign-in when Google is enabled", ...);
it("never offered on guests, to non-admins, or on Access-only installs", ...);
it("confirm, DELETE, then refetch members", ...);
it("404 says there was nothing to reset", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- reset-identity`
Expected: FAIL.

- [ ] **Step 3: Implement per D11.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- reset-identity members`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): reset a member's Google sign-in`

### Task 16: Directory connection page

**Depends on:** Task 2; uses Backend's mocks. **Blocked on D12.**

**Files:**
- Create: `apps/dashboard/src/settings/Directory.tsx`
- Modify: `router.tsx` (`gated("/settings/directory", ADMINS, "/settings/agents", Directory)`), `settings/SettingsLayout.tsx` (tab "Directory", owner and admin, only when `features.spaces`)
- Test: `apps/dashboard/test/directory.test.tsx`

**Interfaces:**
- Consumes: `useDirectory`, `useDirectorySync`, `useConfirmHeld`, `useDisconnectDirectory`, Backend's connect route, `me.user.role`.

- [ ] **Step 1: Write the failing tests**

```ts
it("owner sees Connect Google when mode is off; an admin sees status but no connect", ...);
it("?connected=1 shows success; ?error= shows the failure", ...);
it("shows domain, last success, next run and the last error", ...);
it("auth_failed and backoff explain what happens next", ...);
it("held sweeps list how many would be removed and need the owner to confirm", ...);
it("Disconnect warns that memberships freeze and nothing is removed", ...);
it("Sync now POSTs and shows the new status", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- directory`
Expected: FAIL.

- [ ] **Step 3: Implement per D12.** Connect is a full-page navigation to Backend's connect route.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- directory router`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): Google directory connection page`

---

## Self-review

- **Spec coverage:** 4.1 sign-in → 13 (Google, codes, errors), 15 (identity reset), 14 (real run incl. consent); domain lock and enumeration resistance are P2's server rules, surfaced in 13. 4.2 spaces and personal space → 4, 5; roles → 1, 10, 11; "All members" (`allMembersRole`) → 9; Google-style ownership: managers act on space artifacts → 3, 7; personal not browsable by admins → 5, 9, 12, 14; transfer → 12 (bulk; P3's single transfer has no P4 UI); per-artifact visibility → 8; public links off per space → 8, 9; contractors and guests read-only → 3, 11, 14. 4.3 step 3 (connect IdP, map groups) → 16, 10. 4.5 frozen sync, never widens access → 10, 11, 16. Outside sharing and audit log are M4.
- **Contract reconciliation:** sign-in matches P2 v2's "API contract for P4 (Frontend)"; RBAC matches P3's "API contract for P4". Dropped from earlier drafts: `me.hosted` object, `me.authProvider`, `artifact.can`, the `forbidden` and `invalid_code` error codes, `/no-access?reason`, the server-rendered chooser, 6-digit codes. Five mismatches remain, each with a fallback.
- **Boundary:** no task lists a file under `packages/shared` or `apps/server`.
- **Parallelism:** the table matches each task's Depends on line.
- **Type consistency:** `features`, `readAuthProviders`, `mountHosted`, `artifactCan`, `canPublishTo`, `useHosted`, `useCurrentSpace`, `SpacePicker`, `useMoveArtifact`, `useRunTransfer`, `runAll`, `requestCode`, `verifyCode`, `normalizeCode(raw, length)`, `useResetIdentity` have one signature each across tasks.
- **Review Focus:** five lines, each pinned to named tests in its owning task.
