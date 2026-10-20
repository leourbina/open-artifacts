# Hosted M1 P4: Spaces in the app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard shows spaces (library, publish, move), gives admins pages to run spaces, map Google groups to viewer, editor and manager roles, manage members by hand, and connect and watch the Google directory (FinQore go-live), lets admins transfer a departed person's personal artifacts and reset a Google link, and owns the hosted sign-in page (Google plus emailed 8-digit codes), while a self-hosted install looks and behaves exactly as today.

**Architecture:** Every shape comes from Backend's approved hosted contract (PR #359 at `ed1105c`, `packages/shared/HOSTED_CONTRACT.md`, `src/hosted/*.ts`), read through one dashboard adapter (`api/contract.ts`). Hosted UI is gated on `me.instance.features` (snake_case flags), sign-in on `GET AUTH.providers`, actions on the server-computed `artifact.can`. The SPA owns `/sign-in` (`SIGN_IN_PAGE`); the server is JSON only. This track edits only `apps/dashboard`; the mocks are Backend's, opt-in through `createHandlers({ hosted })`, so existing tests stay unchanged.

**Tech Stack:** React 19, TanStack Router and Query, `@oa/ui` and `@oa/ui/shadcn`, zod, MSW (`@oa/shared/mocks`), vitest plus Testing Library, Playwright (mock config and `playwright.real.config.ts`).

**Spec:** `docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md` (PR #350), sections 4.1, 4.2, 4.3, 4.5. **Contract:** PR #359 at `ed1105c` (approved), `packages/shared/HOSTED_CONTRACT.md` (the authority for every shape below). Backend plans: P2 `docs/superpowers/plans/2026-10-21-hosted-m1-p2-signin.md`, P3 `docs/superpowers/plans/2026-10-21-hosted-m1-p3-rbac.md`. Roadmap: https://artifacts.leourbina.com/a/axtJ4ieni2LsKfTk (M1, P4).

## Global Constraints

- Copy: no em dashes in any user-facing string; say "any AI agent".
- Self-hosted is unchanged: with `me.instance.features` absent or empty, no hosted control renders and no hosted route is called from signed-in pages. `/sign-in` calls `AUTH.providers`; a 404 (older server) or `mode: "access"` renders today's page, and `e2e/signin-split.spec.ts` stays green unedited.
- Actions follow `artifact.can` (`edit, share, setVisibility, delete, transfer, move, dataWrite`) when present; without it (older server) the dashboard derives the same object with the contract's `artifactCan(level, { personal: true, cap: null })`. No component reads `access` for rights.
- Access levels are `owner` (personal owner only), `manager` (space manager), `editor`, `viewer`. Space roles are exactly `viewer`, `editor`, `manager`. Copy says "Manager" for `manager`, never "Owner".
- Data writes: ordinary viewers keep them; guests and restricted (contractor) members are fully read-only. The data-write affordance and the read-only notice follow `can.dataWrite` only. Anonymous writes on public artifacts are unchanged.
- Personal artifacts are private, even from admins: the UI never lists, links or requests another person's personal space or its artifacts; a departed-person transfer shows `TransferSummary { live, deleted }` counts only.
- A tier change never widens access: mapping and restricted-group controls render only when `features` includes `sync_google`; a `409 directory_sync_off` shows the server message. `sync_frozen` rows stay editable by hand; copy never says sync resumes on its own.
- Public links can be off per space (`SpaceRef.publicLinks`); when off, "public" is never offered.
- The personal space id equals the user id. Moves target shared spaces only; `spaceId` is set on create only.
- Errors: no access is 404. The 11 hosted codes each have one owning task and one UI string (see "Error codes, tasks and copy"); `rate_limited` and `unauthorized` with `details.reason` belong to Task 14. The UI shows its own mapped copy (`errorCopy`, Task 2) and falls back to the server's `message`.
- Groups are keyed by `groupId` (Google's stable id) in every route the UI calls; emails and names are display only.
- Restriction: `Member.restriction { manual, groups }` caps a member at viewer everywhere. Admins set or clear only the manual flag (`R.memberRestricted`); a group restriction is lifted only by removing the restricted group, and the UI never implies otherwise.
- Every refused sign-in lands on `/sign-in?error=` (including `no_access`); the dashboard never sends a direct-mode visitor to `/no-access`.
- Sign-in codes: `CODE_POLICY.length` is 8; input goes through the contract's `normalizeCode` (spaces and hyphens stripped). No 6-digit logic anywhere.
- Turnstile: the code-request step has a slot that renders the widget when the email provider carries `turnstileSiteKey`, and sends `turnstileToken`. Turnstile and a request-id cookie are pending Backend's security review; the slot copes with either outcome (no key = no widget).
- Boundary: this track never edits `packages/shared` or `apps/server`. A missing or wrong shape is a message to Backend.
- Visual choices are Design's: tasks marked **Blocked on D#** start only after the user picks. Logic and tests may be written first against a neutral layout built from existing `@oa/ui` primitives.
- No `git stash`. One PR per task (or a small group), through the merge queue.

## Review Focus

1. **A self-hosted instance after upgrade.** Signed-in pages make no request to `R.spaces`, `R.directory` or any hosted route, and render nothing new. `/sign-in` does request `AUTH.providers` (it must, to know the mode); a 404 or `mode: "access"` renders today's Access page unchanged. Pinned in Task 1 (`no features: no hosted request from signed-in pages`) and Task 14 (`providers 404 renders today's page`, `access mode renders today's page`).
2. **A viewer, a guest or a contractor opens an artifact.** No edit, share, move or delete; a viewer with `can.dataWrite` still votes; a guest or contractor sees the read-only notice and no data-write affordance; a stale tab that tries anyway shows the server's message. Pinned in Task 3.
3. **An admin handling a departed person.** Counts only, never titles or artifact requests; the departed person and guests can't be successors; more than 100 artifacts finish through the cursor loop; reopening resumes from a fresh summary. Pinned in Task 13.
4. **Emailed code typos and abuse.** `2468-1357` and `2468 1357` verify; a wrong code shows attempts left; the fifth wrong try expires it; `no_pending` returns to the email step; `rate_limited` shows the wait; Turnstile failure keeps the email; nothing reveals whether an address can sign in. Pinned in Task 14.
5. **FinQore's directory goes unhealthy.** Owners and admins see the sync-health banner (and the "agent tokens not re-verified" note) after an hour; members never do; a held sweep waits for the owner's confirmation; a stale owner gets `reauth_required` and a fresh Google sign-in link instead of a dead page. Pinned in Tasks 4, 17 and 18.

---

## Contract use (PR #359)

P4 adopts the contract exactly. What each area of the UI reads:

| UI area | Contract |
|---|---|
| Gates | `Me.instance.features: FeatureFlag[]` (`spaces`, `sync_google`, `sync_frozen`, `guests_read_only`, `content_revocation`, `usage_off`), `Me.instance.hosted`, `Me.instance.tier` (`trial \| team \| business`, null self-hosted), `Me.instance.signIn`, `Me.instance.directory { mode, healthy, unhealthySince, banner, tokensUnverified }`, `Me.auth { method, readOnly, cap, expiresAt }`, `Me.personalSpaceId`, `Me.spaces: MySpace[]` |
| Artifacts | `ArtifactSummary.space?: SpaceRef { id, kind, name, publicLinks }`, `ArtifactSummary.can?: ArtifactCan`, `AccessLevel` with `manager`; `HostedListQuery` (`scope: space \| spaces`, `spaceId`), `HostedSearchQuery` (`spaceId`), `HostedPublishInput` (`spaceId`, create only); `R.moveArtifact` `{ spaceId }`, `R.transferArtifact` `{ userId }` |
| Spaces | `R.spaces` (`SpacesQuery` → `Page<Space>`), `R.space`, `SpaceCreate`/`SpacePatch` `{ name, allMembersRole, publicLinks }` (no `outsideSharing` until M4), `SPACE_MANAGER_FIELDS` (name, publicLinks); `R.spaceMembers` (`Page<SpaceMember>`, `groups: GroupRef[]`), `R.spaceMember(id, userId)` `{ role }`, `R.spaceMemberSelf(id)` (admin adds themselves, audited); `R.spaceMappings`, `R.spaceMapping(id, groupId)` `{ role }`; `R.restrictedGroups`, `R.restrictedGroup(groupId)` (PUT 409 when off or frozen; DELETE in any mode) |
| Directory | `R.directory` (`SyncStatus { mode, binding, healthy, state, unhealthySince, lastSuccessAt, lastError, nextRunAt, staleAt, alertedAt, customerMismatch, held: (GroupRef & { wouldRemove, members, since })[] }`), `R.directoryGroups` (`Page<DirectoryGroup { groupId, email, name, memberCount }>`), `R.directoryConnect`, callback `/settings/directory?connected=1` or `?error=DirectoryConnectError`, `R.directorySync`, `R.directoryHeldConfirm(groupId)`, `DELETE R.directory` |
| Members | `Member.status`, `Member.identities`, `Member.restriction { manual, groups: GroupRef[] } \| null`, `R.memberRestricted(id)` (PUT/DELETE → `Member`, manual flag only), `R.members?status=`, `R.memberTransfer` (GET `TransferSummary`, POST `TransferInput` → `TransferResult { moved, remaining, nextCursor }`, `TRANSFER_PAGE` 100), `R.memberIdentity(id, "google")` |
| Sign-in | `SIGN_IN_PAGE`, `AUTH.providers` (`AuthProviders { mode, providers: access{start} \| google{start, domains} \| email{domainCodes, guests, turnstileSiteKey?} }`), `AUTH.loginGoogle`, `AUTH.codeRequest` (`CodeRequest { email, next?, turnstileToken? }` → 202 `CodeRequested { maskedEmail, expiresIn, resendAfter, codeLength }`), `AUTH.codeVerify` (`{ code }` plus cookie → `CodeVerified { next, user, readOnly }`; 401 `details.reason` `invalid_code{attemptsLeft} \| expired \| no_pending`; 429 locked), `SignInError` (`tenant \| identity_conflict \| removed \| no_access \| expired \| failed`; every refusal lands here); `turnstile_required` 400 `details.field: "turnstile"`; locked verify 429 `{ retryAfter, scope: "ip" }`, `CODE_POLICY`, `normalizeCode` |
| Mocks | `createHandlers({ hosted: true \| HostedMockOptions })` with `mode`, `providers`, `turnstile`, `tier`, `directory`, `unhealthy`, `features`. Store: personal space per member; Engineering `SpEngNpQrSt2uVwX` (caller manager, `allMembersRole: "viewer"`, holds "Meeting notes" `De6gHjKmNp7qRsTu`); Exec `SpExcNpQrSt3uVwX` (caller viewer, `publicLinks: false`); Clients `SpCliNpQrSt4uVwX` (admin view, `myRole: null`); Ada `Ab3dEfGhJk4mNpQr` (owner, `identities: ["google"]`); Bob `Bc4eFgHjKm5nPqRs`; Carol `Cr7tNpQrSt8uVwXy` suspended, `{ live: 2, deleted: 1 }`; groups `gEng01` (eng@), `gExec02` (exec@), `gSales03` (sales@), `gCon04` (restricted Contractors, member Dan `Dn8uPqRsTu9vWxYz`, `cap: "restricted"`); held sweep `gSales03` (`wouldRemove: 4`); `public_links_off` on PATCH and publish; `HOSTED_MOCK_CODE` `24681357`; `MOCK_DOMAIN` `example.com`; masked `b***@example.com`; Turnstile site key `1x00000000000000000000AA` |

**Mismatches with the contract (`ed1105c`):** none. Out of P4's M1 scope by design: the single-artifact transfer (`R.transferArtifact`) has no UI yet, and the audit log (`R.audit`) is M4. Pending Backend's security review: Turnstile on domain code requests and a request-id cookie; Task 14's slot covers both outcomes.

## Error codes, tasks and copy

`api/errorCopy.ts` (Task 2) maps each code to the UI string below; any other error shows the server's `message`. **Every string in this table needs Design's sign-off** (they are proposals; Design may reword them, the code-to-task mapping is fixed).

| Code | Status | Where it can happen | Task | UI copy (proposed) |
|---|---|---|---|---|
| `space_forbidden` | 403 | publish into a space; move into a space; any create by a capped caller | 7, 8 | "You can't publish to this space. Ask a space manager for editor access." |
| `space_personal` | 400 | a personal space as a move target or a spaces-route target (the pickers never offer one; defensive) | 8, 10 | "Personal spaces can't be used here." |
| `space_not_empty` | 409 | delete a space that still holds artifacts (trash counts) | 10 | "Move or delete this space's artifacts first, including the trash." |
| `public_links_off` | 403 | make an artifact public in a space whose public links are off (Share, or a stale tab) | 9 | "Public links are turned off for this space." |
| `use_move` | 400 | `spaceId` on publish to an existing artifact (the upload never sends one; defensive) | 7 | "This artifact already exists. Use Move to change its space." |
| `invalid_successor` | 400 | transfer to a guest, a restricted member or an inactive member | 13 | "Choose an active member who isn't a guest or restricted." |
| `member_active` | 409 | departed-person transfer on someone who is active again | 13 | "This person is active again, so their artifacts stay with them." |
| `directory_sync_off` | 409 | mapping or restricted-group change, or Sync now, while sync is off or frozen | 11, 17, 18 | "Directory sync is off, so groups can't be changed here." |
| `turnstile_required` | 400 (`details.field: "turnstile"`) | code request without a token | 14 | "Complete the verification first." (shown at the Turnstile slot) |
| `turnstile_failed` | 403 | code request with a rejected token | 14 | "Verification failed. Try again." |
| `reauth_required` | 401 | directory routes for a stale owner | 17 | "For your security, sign in with Google again to manage the directory." |

Other copy that needs Design: every `SignInError` and 401 reason string (Task 14), the read-only notice (Task 3), the sync banner (Task 4), the public-off note (Task 9), the frozen banner (Task 12), the transfer counts and dialog (Task 13), the restriction labels and confirmations (Task 15), the reset confirmation (Task 16), the directory status labels, callback errors, disconnect and held-sweep confirmations (Tasks 17, 18).

## Task order and parallelism

| Task | Depends on | Blocked on Design | Parallel with |
|---|---|---|---|
| 1 Consume contract | PR #359 merged | none | Design work |
| 2 Hooks and calls | 1 | none | 3, 4 |
| 3 Actions from `can` | 1 | D10 (notice look only) | 2, 4 |
| 4 Hosted chrome | 1 | D13 | 2, 3 |
| 5 Library filter | 2 | none | 7, 9, 10, 13 to 17 |
| 6 Switcher, marker | 5 | D1, D2, D3 | 8, 11, 18 |
| 7 Publish picker | 2 | D4 | 5, 9, 10, 13 to 17 |
| 8 Move | 2, 3, 7 | D3, D4 | 6, 11, 18 |
| 9 Public links off | 2, 3 | D9 | 5, 7, 10, 13 to 17 |
| 10 Spaces admin | 2 | D5, D9 | 5, 7, 9, 13 to 16 |
| 11 Group mappings | 10 | D5 | 6, 8, 18 |
| 12 Space members | 11 | D6 | 18 |
| 13 Departed transfer | 2 | D7 | wave 3 except 15, 16 |
| 14 Sign-in page | 2 | D8 | wave 3 |
| 15 Restricted members | 2 | D14 | wave 3 except 13, 16 (same file) |
| 16 Reset Google link | 2 | D11 | wave 3 except 13, 15 |
| 17 Directory page | 2, 4 | D12 | wave 3 except 10 |
| 18 Held sweeps, restricted groups | 17 | D12 | 6, 8, 11, 12 |
| 19 Real e2e | 3 to 18; P2 and P3 merged | none | none |

Waves: 1; then 2, 3, 4; then 5, 7, 9, 10, 13, 14, 15, 16, 17; then 6, 8, 11, 18; then 12; then 19. **FinQore go-live path:** 1, 2, 4, 17, 18, plus 10 and 11 to map groups. Same-file pairs run in sequence: `router.tsx` (5, 10, 14, 17), `SettingsLayout.tsx` (4, 10, 17), `Library.tsx` (5, 6), `Details.tsx` (3, 8), `Share.tsx` (3, 9), `SpaceAccess.tsx` (11, 12), `Members.tsx` (13, 15, 16), `Directory.tsx` (17, 18).

**The 13 dashboard e2e specs the hosted contract touches, by owner:** Task 1 keeps `cpu-limit`, `embed`, `renav-notice`, `display-name` green unedited (mocks are opt-in); Task 4 extends `usage-layout`, `settings-layout`; Task 6 extends `library-layout`, `card-inset`; Task 9 extends `share-layout`; Tasks 13, 15 and 16 extend `invite-link`; Task 14 extends `m1-a11y`, `m2-a11y`, `m2-hostile`.

## Design options needed

Each is a question for Design, who produce options; the user picks.

- **D1 Space switcher**: sidebar list, library header dropdown, or a tab strip replacing All / Mine / Shared / Team; how it fits the scope tabs.
- **D2 Personal space**: name ("My space", "Personal", the person's name), icon, position.
- **D3 Space marker**: on cards, rows, the viewer title bar, search hits; "Created by" for shared-space artifacts.
- **D4 Space picker**: control in Create artifact and Move, preselection, spaces you can't publish to (hidden vs disabled with a reason).
- **D5 Spaces admin page**: layout of `/settings/spaces`, the group-to-role row, the group picker, "All members" (`allMembersRole`).
- **D6 Space members**: manual vs synced rows, the granting groups, `cap` markers (guest, restricted), adding a person, the frozen state and its Team copy.
- **D7 Departed transfer**: where departed people show, the dialog (successor or space), progress.
- **D8 Sign-in and no-access**: Google button with domains, email then 8-digit code (one field vs boxes), masked address, resend timer, expiry, Turnstile placement, every `error=` and 401 reason, "not set up" state, hosted brand footer.
- **D9 Public links off**: Share panel treatment and the space toggle.
- **D10 Read-only notice**: the notice for `!can.dataWrite` (guest, contractor) and whether viewers get a "View only" marker.
- **D11 Reset Google link**: placement on a Members row and the confirmation.
- **D14 Restricted members**: how a restricted member shows on Members and in space members (manual vs "via Contractors"), the admin control to set or clear the manual flag, its confirmation, and how a group restriction reads as not clearable here.
- **D12 Directory page**: `/settings/directory` connect state, binding, status by `state`, errors by `DirectoryConnectError`, Sync now, Disconnect, held sweeps, restricted groups, the reauth prompt.
- **D13 Sync-health banner**: placement and copy of the `directory.banner` warning and the `tokensUnverified` note.

---

## File Structure

Only `apps/dashboard` changes.

`apps/dashboard/src`
- `api/contract.ts` (create): the one import point for hosted shapes; `features`, `hasFeature`, `readAuthProviders`, `canOf`.
- `api/queries.ts` (modify): space, member, mapping, restricted-group, directory, move, transfer, identity hooks and `qk` keys.
- `api/auth.ts` (create): `useAuthProviders`, `requestCode`, `verifyCode`.
- `auth/permissions.ts` (create): `useHosted`, `canPublishTo`, `accessLabel`.
- `layout/SyncBanner.tsx` (create); `layout/AppLayout.tsx`, `layout/CpuBanner.tsx`, `layout/QuotaBanner.tsx` (modify: `usage_off`).
- `spaces/` (create): `useCurrentSpace.ts`, `SpaceSwitcher.tsx`, `SpaceMarker.tsx`, `SpacePicker.tsx`, `MoveDialog.tsx`.
- `settings/spaces/` (create): `Spaces.tsx`, `SpaceAccess.tsx`, `GroupPicker.tsx`.
- `settings/Directory.tsx` (create), `settings/Transfer.tsx` (create), `settings/Members.tsx` (modify).
- `pages/SignIn.tsx` (modify), `pages/CodeSignIn.tsx` (create), `pages/Turnstile.tsx` (create), `pages/NoAccess.tsx` (modify: direct mode redirects to `/sign-in?error=no_access`).
- `api/errorCopy.ts` (create): code to UI string.
- `main.tsx` (modify: `?hosted=` mock switch), `router.tsx`, `library/{Library,ArtifactCard,ArtifactRow}.tsx`, `library/{useLibraryQuery,useSearchQuery}.ts`, `upload/{UploadDialog,DropZone}.tsx`, `upload/uploadPipeline.ts`, `viewer/{TitleBar,Shell}.tsx`, `viewer/panels/{Details,Versions,Share}.tsx`, `settings/SettingsLayout.tsx` (modify).

Tests: `apps/dashboard/test/{contract,hosted-queries,permissions,hosted-chrome,spaces-library,spaces-publish,spaces-move,share-public-off,spaces-admin,space-access,transfer,signin-hosted,restricted,reset-identity,directory,error-copy}.test.tsx`; `test/harness.tsx` (modify); `e2e/{spaces,signin-hosted,directory}.spec.ts` (create); the 13 specs above; `e2e/real/spaces.spec.ts` (create), `e2e/real/consent.spec.ts`, `e2e/real/fixtures.ts` (modify).

---

### Task 1: Consume the contract (adapter, harness, mock switch)

**Depends on:** PR #359 merged to `main`.

**Files:**
- Create: `apps/dashboard/src/api/contract.ts`
- Modify: `apps/dashboard/test/harness.tsx`, `apps/dashboard/src/main.tsx`
- Test: `apps/dashboard/test/contract.test.ts`

**Interfaces:**
- Produces:
  - `contract.ts` re-exports every hosted type and constant the dashboard uses (`ArtifactCan`, `MySpace`, `Space`, `SpaceRef`, `SpaceRole`, `SpaceKind`, `SpaceMember`, `GroupMapping`, `RestrictedGroup`, `DirectoryGroup`, `SyncStatus`, `DirectoryConnectError`, `FeatureFlag`, `Tier`, `CapReason`, `InstanceDirectory`, `InstanceSignIn`, `MeAuth`, `TransferSummary`, `TransferInput`, `TransferResult`, `AuthProviders`, `CodeRequest`, `CodeRequested`, `CodeVerified`, `SignInError`, `CODE_POLICY`, `TRANSFER_PAGE`, `SPACE_MANAGER_FIELDS`, `SIGN_IN_PAGE`, `normalizeCode`, `artifactCan`). No other dashboard file imports these from `@oa/shared`.
  - `features(me: Me | null): FeatureFlag[]` → `me?.instance.features ?? []`; `hasFeature(me: Me | null, f: FeatureFlag): boolean`.
  - `canOf(a: ArtifactSummary): ArtifactCan` → `a.can ?? artifactCan(a.access, { personal: true, cap: null })`.
  - `readAuthProviders(raw: unknown): AuthProviders` → parsed, else `{ mode: "access", providers: [{ id: "access", start: AUTH.login }] }`.
  - `harness.tsx`: `mountHosted(path: string, opts?: true | HostedMockOptions, me?: (m: Me) => Me): Router` (prepends `createHandlers({ hosted: opts })`; `me` rewrites the hosted `/me` body); `calls(method?: string): { path: string; search: URLSearchParams; body: unknown }[]` (records every request from the call on).
  - `main.tsx`: mock-only `parseHostedParam(raw: string | null): HostedMockOptions | undefined` for `?hosted=`, comma tokens `1` (defaults), `access`, `email-only`, `turnstile`, `unhealthy`, `trial`, `team`, `business`, `frozen`, `sync-off`.

- [ ] **Step 1: Write the failing tests**

```ts
import { fixtures } from "@oa/shared/mocks";
import { canOf, features, hasFeature, readAuthProviders } from "../src/api/contract";
import { parseHostedParam } from "../src/main";

test("me without hosted fields has no features", () => {
  expect(features(fixtures.me)).toEqual([]);
  expect(hasFeature(fixtures.me, "spaces")).toBe(false);
});

test("canOf derives the action table when the server omits can", () => {
  const a = { ...fixtures.artifacts[0], access: "editor" as const, can: undefined };
  expect(canOf(a)).toEqual({ edit: true, share: false, setVisibility: false, delete: false, transfer: false, move: false, dataWrite: true });
});

test("canOf prefers the server's can", () => {
  const can = { edit: false, share: false, setVisibility: false, delete: false, transfer: false, move: false, dataWrite: false };
  expect(canOf({ ...fixtures.artifacts[0], can })).toBe(can);
});

test("readAuthProviders falls back to access mode", () => {
  expect(readAuthProviders(undefined)).toEqual({ mode: "access", providers: [{ id: "access", start: "/auth/login" }] });
});

test("hosted param tokens", () => {
  expect(parseHostedParam(null)).toBeUndefined();
  expect(parseHostedParam("1")).toEqual({});
  expect(parseHostedParam("team,frozen,unhealthy")).toEqual({ tier: "team", directory: "frozen", unhealthy: true });
  expect(parseHostedParam("access")).toEqual({ mode: "access" });
  expect(parseHostedParam("email-only,turnstile")).toEqual({ providers: ["email"], turnstile: true });
});

test("no features: no hosted request from signed-in pages", async () => {
  const seen = calls();
  mount("/");
  await screen.findByText("Landing page");
  for (const p of ["/api/v1/spaces", "/api/v1/directory", "/auth/providers"])
    expect(seen.some((c) => c.path.startsWith(p))).toBe(false);
});

test("hosted mock me carries the hosted fields", async () => {
  mountHosted("/", { tier: "team", directory: "frozen" });
  const me = await waitFor(() => {
    const m = lastClient.getQueryData<Me>(["me"]);
    if (!m) throw new Error("no me yet");
    return m;
  });
  expect(me.personalSpaceId).toBe("Ab3dEfGhJk4mNpQr");
  expect(me.instance.tier).toBe("team");
  expect(me.instance.directory?.mode).toBe("frozen");
  expect(me.spaces?.map((s) => [s.name, s.myRole])).toEqual([["Engineering", "manager"], ["Exec", "viewer"]]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- contract`
Expected: FAIL, `../src/api/contract` not found.

- [ ] **Step 3: Implement `contract.ts`, the harness helpers and `parseHostedParam`.** `main.tsx` passes `hosted: parseHostedParam(params.get("hosted"))` to `createHandlers`. If a shape in this plan differs from PR #359, follow the PR and update later Interfaces in the same PR.

- [ ] **Step 4: Run the suites; the opt-in mocks leave existing specs unchanged**

Run: `pnpm --filter @oa/dashboard test && pnpm --filter @oa/dashboard typecheck && pnpm --filter @oa/dashboard test:e2e -- cpu-limit embed renav-notice display-name`
Expected: PASS, those four specs unedited.

- [ ] **Step 5: Commit** `feat(dashboard): consume the hosted contract`

### Task 2: Query hooks and sign-in calls

**Depends on:** Task 1.

**Files:**
- Modify: `apps/dashboard/src/api/queries.ts`
- Create: `apps/dashboard/src/api/auth.ts`
- Test: `apps/dashboard/test/hosted-queries.test.tsx`, `apps/dashboard/test/qk.test.ts`

**Interfaces:**
- Consumes: `contract.ts`; `R.*`, `AUTH.*`.
- Produces:
  - `qk.spaces(q?)` = `["spaces", q ?? {}]`, `qk.space(id)` = `["spaces", id]`, `qk.spaceMembers(id)` = `["spaces", id, "members"]`, `qk.spaceMappings(id)` = `["spaces", id, "mappings"]`, `qk.directory` = `["directory"]`, `qk.restrictedGroups` = `["directory", "restricted"]`, `qk.directoryGroups(q)` = `["directory", "groups", q]`, `qk.memberTransfer(id)` = `["members", id, "transfer"]`; `qk.members` stays `["members"]`, with `useMembers(status?)` keyed `["members", status ?? "active"]`.
  - Hooks: `useSpaces(q?: SpacesQuery, enabled?)` (infinite), `useSpace(id, enabled?)`, `useCreateSpace()`, `usePatchSpace(id)`, `useDeleteSpace()`, `useSpaceMembers(id)` (infinite), `usePutSpaceMember(id)` (`{ userId, role }`), `useDeleteSpaceMember(id)`, `useSpaceMappings(id)`, `usePutMapping(id)` (`{ groupId, role }`), `useDeleteMapping(id)`, `useRestrictedGroups()`, `usePutRestrictedGroup()` (`groupId`), `useDeleteRestrictedGroup()` (`groupId`), `useSetRestricted()` (`{ memberId, restricted: boolean }` → PUT or DELETE `R.memberRestricted`), `useAddSelfToSpace(id)` (`{ role }` → `R.spaceMemberSelf`), `useDirectory(enabled?)`, `useDirectoryGroups(q)` (infinite; enabled at 2+ characters), `useDirectorySync()`, `useConfirmHeld()` (`groupId`), `useDisconnectDirectory()`, `useMoveArtifact(id)` (`mutateAsync(spaceId)`), `useTransferSummary(memberId)`, `useRunTransfer(memberId)` (one page per `mutateAsync(TransferInput)`), `useResetIdentity()` (`mutateAsync(memberId)`).
  - `api/auth.ts`: `useAuthProviders()` (`retry: false`, through `readAuthProviders`), `requestCode(input: CodeRequest): Promise<CodeRequested>`, `verifyCode(code: string): Promise<CodeVerified>`; both send `X-OA-Request: 1` and throw `ApiClientError` with `details`.

- [ ] **Step 1: Write the failing tests**

```ts
it("useSpaces pages Clients, Engineering and Exec for an admin", async () => {
  mountHosted("/");
  const { result } = renderHook(() => useSpaces({ kind: "shared" }), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data!.pages[0].items.map((s) => [s.name, s.myRole])).toEqual([
    ["Clients", null], ["Engineering", "manager"], ["Exec", "viewer"],
  ]);
});

it("move invalidates the artifact, the library and spaces", async () => {
  mountHosted("/");
  const spy = vi.spyOn(lastClient, "invalidateQueries");
  const { result } = renderHook(() => useMoveArtifact("De6gHjKmNp7qRsTu"), { wrapper });
  await result.current.mutateAsync("SpExcNpQrSt3uVwX").catch(() => {});
  expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual(
    expect.arrayContaining([["artifact", "De6gHjKmNp7qRsTu"], ["artifacts"], ["spaces"]]),
  );
});

it("mapping 409 toasts the failure title and the server message", async () => {
  mountHosted("/", { directory: "frozen" });
  const { result } = renderHook(() => usePutMapping("SpEngNpQrSt2uVwX"), { wrapper });
  await result.current.mutateAsync({ groupId: "gEng01", role: "manager" }).catch(() => {});
  expect(await screen.findByText("Couldn't change access.")).toBeVisible();
});

it("directory group search waits for two characters", async () => {
  mountHosted("/");
  const seen = calls("GET");
  renderHook(() => useDirectoryGroups("s"), { wrapper });
  await wait(50);
  expect(seen.filter((c) => c.path === "/api/v1/directory/groups")).toHaveLength(0);
});

it("useRunTransfer posts the cursor it is given", async () => {
  mountHosted("/");
  const seen = calls("POST");
  const { result } = renderHook(() => useRunTransfer("Cr7tNpQrSt8uVwXy"), { wrapper });
  await result.current.mutateAsync({ to: { kind: "user", userId: "Bc4eFgHjKm5nPqRs" }, cursor: "c1" }).catch(() => {});
  expect(seen.at(-1)).toMatchObject({ path: "/api/v1/members/Cr7tNpQrSt8uVwXy/transfer", body: { to: { kind: "user", userId: "Bc4eFgHjKm5nPqRs" }, cursor: "c1" } });
});

it("requestCode returns the server's policy", async () => {
  mountHosted("/sign-in");
  await expect(requestCode({ email: "bob@example.com" })).resolves.toEqual({
    maskedEmail: "b***@example.com", expiresIn: 600, resendAfter: 60, codeLength: 8,
  });
});

it("verifyCode keeps 401 details", async () => {
  mountHosted("/sign-in");
  await requestCode({ email: "bob@example.com" });
  const e = await verifyCode("11111111").catch((x) => x);
  expect([e.status, e.details]).toEqual([401, { reason: "invalid_code", attemptsLeft: 4 }]);
});

it("useAuthProviders reads a 404 as access mode", async () => {
  server.use(http.get("*/auth/providers", () => new HttpResponse(null, { status: 404 })));
  const { result } = renderHook(() => useAuthProviders(), { wrapper });
  await waitFor(() => expect(result.current.data?.mode).toBe("access"));
});
```

(`wrapper` provides `lastClient`; `renderHook` comes from Testing Library.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- hosted-queries qk`
Expected: FAIL, hooks not exported.

- [ ] **Step 3b: Error copy.** Create `api/errorCopy.ts`: `errorCopy(e: unknown, fallback: string): string` returns the table's string for the 11 hosted codes, else the `ApiClientError` message, else `fallback`. Test in `test/error-copy.test.ts`:

```ts
it.each([
  ["space_forbidden", "You can't publish to this space. Ask a space manager for editor access."],
  ["space_personal", "Personal spaces can't be used here."],
  ["space_not_empty", "Move or delete this space's artifacts first, including the trash."],
  ["public_links_off", "Public links are turned off for this space."],
  ["use_move", "This artifact already exists. Use Move to change its space."],
  ["invalid_successor", "Choose an active member who isn't a guest or restricted."],
  ["member_active", "This person is active again, so their artifacts stay with them."],
  ["directory_sync_off", "Directory sync is off, so groups can't be changed here."],
  ["turnstile_required", "Complete the verification first."],
  ["turnstile_failed", "Verification failed. Try again."],
  ["reauth_required", "For your security, sign in with Google again to manage the directory."],
])("%s", (code, copy) => {
  expect(errorCopy(new ApiClientError(code as ErrorCode, "server text", 400), "x")).toBe(copy);
});
it("other codes fall back to the server message, then the fallback", () => {
  expect(errorCopy(new ApiClientError("not_found", "Not found", 404), "x")).toBe("Not found");
  expect(errorCopy(new Error("boom"), "Couldn't save.")).toBe("Couldn't save.");
});
```

- [ ] **Step 3: Implement** with `useInvalidating`; toast descriptions come from `errorCopy`; failure titles: "Couldn't create the space.", "Couldn't save the space.", "Couldn't delete the space.", "Couldn't change access.", "Couldn't move the artifact.", "Couldn't transfer the artifacts.", "Couldn't reset the sign-in.", "Couldn't start a sync.", "Couldn't apply the change.", "Couldn't disconnect."

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- hosted-queries qk error-copy`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(dashboard): hosted query hooks and sign-in calls`

### Task 3: Actions follow `can`; the read-only notice follows `can.dataWrite`

**Depends on:** Task 1. **Blocked on D10** for the notice's look only.

**Files:**
- Create: `apps/dashboard/src/auth/permissions.ts`
- Modify: `viewer/TitleBar.tsx:142-143`, `viewer/panels/Details.tsx:29-30`, `viewer/panels/Versions.tsx:22`, `viewer/panels/Share.tsx:109`, `viewer/Shell.tsx` (notice), `upload/DropZone.tsx:35`, `library/Library.tsx` (DropZone `allowed`)
- Test: `apps/dashboard/test/permissions.test.tsx`

**Interfaces:**
- Consumes: `canOf`, `features`, `useMe`.
- Produces: `useHosted(): { features: FeatureFlag[]; tier: Tier | null; spaces: MySpace[]; personalSpaceId: string | null; readOnly: boolean; cap: CapReason | null; signIn: InstanceSignIn | null; directory: InstanceDirectory | null }`; `canPublishTo(s: { kind: SpaceKind; myRole: SpaceRole | null }, cap: CapReason | null): boolean` → `cap === null && (kind === "personal" || myRole === "editor" || myRole === "manager")`; `accessLabel(level: AccessLevel): "Owner" | "Manager" | "Editor" | "Viewer"`.

- [ ] **Step 1: Write the failing tests**

```ts
const viewerCan = { edit: false, share: false, setVisibility: false, delete: false, transfer: false, move: false, dataWrite: true };
const serve = (a: object) => server.use(http.get(`*${R.artifact(arts[0].id)}`, () => HttpResponse.json({ ...arts[0], ...a })));

it("viewer sees no edit affordance but keeps data writes", async () => {
  serve({ access: "viewer", can: viewerCan, capabilities: { db: true, viewer: false, storage: false } });
  mount(`/a/${arts[0].id}`);
  await screen.findByRole("heading", { name: arts[0].title });
  for (const name of ["Rename", "Restore", "Delete", "Save visibility", "Move"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByText("You can view this, but not change it.")).toBeNull();
});

it("guest sees the read-only notice when can.dataWrite is false", async () => {
  serve({ access: "viewer", can: { ...viewerCan, dataWrite: false }, capabilities: { db: true, viewer: false, storage: false } });
  mount(`/a/${arts[0].id}`);
  expect(await screen.findByText("You can view this, but not change it.")).toBeVisible(); // copy per D10
});

it("no notice on an artifact without live data", async () => {
  serve({ access: "viewer", can: { ...viewerCan, dataWrite: false }, capabilities: { db: false, viewer: false, storage: false } });
  mount(`/a/${arts[0].id}`);
  await screen.findByRole("heading", { name: arts[0].title });
  expect(screen.queryByText("You can view this, but not change it.")).toBeNull();
});

it("space manager is labelled Manager, never Owner", async () => {
  serve({ access: "manager", can: { ...viewerCan, edit: true, share: true, setVisibility: true, delete: true, move: true } });
  mount(`/a/${arts[0].id}`);
  expect(await screen.findByText("Manager")).toBeVisible();
  expect(screen.queryByText(/you own this/i)).toBeNull();
});

it("readOnly guest gets no Create artifact control", async () => {
  mountHosted("/shared", true, (m) => ({ ...m, user: { ...m.user, role: "guest" }, auth: { method: "code", readOnly: true, cap: "guest", expiresAt: null } }));
  await screen.findByRole("heading", { name: "Library" });
  expect(screen.queryByRole("button", { name: "Create artifact" })).toBeNull();
});

it("404 on rename toasts the server message and keeps the title", async () => {
  server.use(http.patch(`*${R.artifact(arts[0].id)}`, () => HttpResponse.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })));
  mount(`/a/${arts[0].id}`);
  fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
  const box = screen.getByRole("textbox", { name: "Title" });
  fireEvent.change(box, { target: { value: "New" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await screen.findByText("Not found")).toBeVisible();
  expect(screen.getByRole("heading", { name: arts[0].title })).toBeVisible();
});

it("canPublishTo", () => {
  expect(canPublishTo({ kind: "shared", myRole: "viewer" }, null)).toBe(false);
  expect(canPublishTo({ kind: "shared", myRole: null }, null)).toBe(false);
  expect(canPublishTo({ kind: "shared", myRole: "editor" }, null)).toBe(true);
  expect(canPublishTo({ kind: "personal", myRole: "manager" }, "restricted")).toBe(false);
});

it("accessLabel", () => {
  expect(["owner", "manager", "editor", "viewer"].map((l) => accessLabel(l as AccessLevel))).toEqual(["Owner", "Manager", "Editor", "Viewer"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- permissions`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `permissions.ts`; replace every `access` rights check with `canOf(artifact)`; the Shell shows the notice when `(capabilities.db || capabilities.storage) && !canOf(a).dataWrite`.

- [ ] **Step 4: Run the full suite**

Run: `pnpm --filter @oa/dashboard test`
Expected: PASS, including `share.test.tsx`, `versions.test.tsx`, `shell.test.tsx` unedited.

- [ ] **Step 5: Commit** `refactor(dashboard): actions follow can; read-only notice`

### Task 4: Hosted chrome (sync-health banner, usage off)

**Depends on:** Task 1. **Blocked on D13.**

**Files:**
- Create: `apps/dashboard/src/layout/SyncBanner.tsx`
- Modify: `layout/AppLayout.tsx`, `layout/CpuBanner.tsx`, `layout/QuotaBanner.tsx`, `settings/SettingsLayout.tsx`, `router.tsx` (usage route), `e2e/usage-layout.spec.ts`, `e2e/settings-layout.spec.ts`
- Test: `apps/dashboard/test/hosted-chrome.test.tsx`

**Interfaces:**
- Consumes: `useHosted().directory`, `features`.
- Produces: `<SyncBanner />` (renders when `directory.banner`; adds the tokens note when `directory.tokensUnverified`; links to `/settings/directory`).

- [ ] **Step 1: Write the failing tests**

```ts
it("owner sees the sync banner after an hour unhealthy", async () => {
  mountHosted("/", { unhealthy: true });
  const b = await screen.findByRole("status", { name: "Directory sync" });
  expect(b).toHaveTextContent("Google directory sync is failing"); // copy per D13
  expect(b).toHaveTextContent("Agent tokens aren't being re-verified");
  expect(within(b).getByRole("link", { name: "Open directory settings" })).toHaveAttribute("href", "/settings/directory");
});

it("members never see the sync banner", async () => {
  mountHosted("/", { unhealthy: true }, (m) => ({ ...m, user: { ...m.user, role: "member" }, instance: { ...m.instance, directory: { ...m.instance.directory!, banner: false, tokensUnverified: false } } }));
  await screen.findByRole("heading", { name: "Library" });
  expect(screen.queryByRole("status", { name: "Directory sync" })).toBeNull();
});

it("healthy sync shows no banner", async () => {
  mountHosted("/");
  await screen.findByRole("heading", { name: "Library" });
  expect(screen.queryByRole("status", { name: "Directory sync" })).toBeNull();
});

it("usage_off hides Usage and never requests it", async () => {
  const seen = calls("GET");
  mountHosted("/settings/profile");
  await screen.findByRole("navigation", { name: "Settings sections" });
  expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();
  expect(seen.some((c) => c.path === "/api/v1/usage")).toBe(false);
});

it("/settings/usage redirects to /settings/profile under usage_off", async () => {
  const router = mountHosted("/settings/usage");
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings/profile"));
});
// usage-layout.spec.ts: "hosted: no Usage link" at /?hosted=1
// settings-layout.spec.ts: hosted tab strip (Profile, Members, Spaces, Directory, Agents, Instance) at 375 scrolls without clipping
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- hosted-chrome`
Expected: FAIL.

- [ ] **Step 3: Implement per D13.** `CpuBanner` and `QuotaBanner` skip their `R.usage` reads under `usage_off`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- hosted-chrome cpu-banner layout && pnpm --filter @oa/dashboard test:e2e -- usage-layout settings-layout`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(layout): sync-health banner; hide usage when off`

### Task 5: Library space filter (URL and query)

**Depends on:** Task 2.

**Files:**
- Modify: `router.tsx` (library `validateSearch`), `library/useLibraryQuery.ts`, `library/useSearchQuery.ts`, `library/Library.tsx`
- Create: `apps/dashboard/src/spaces/useCurrentSpace.ts`
- Test: `apps/dashboard/test/spaces-library.test.tsx`

**Interfaces:**
- Consumes: `useHosted`, `useSpace`.
- Produces: search param `space?: string`; `LibraryFilters.space?: string`, sent as `scope=mine` when it equals `personalSpaceId`, else `scope=space&spaceId=<id>`; search adds `spaceId`; `useCurrentSpace(): { space: SpaceRef | null; set(id?: string): void }` (resolves from `me.spaces`, then `useSpace(id)`; a 404 clears the param).

- [ ] **Step 1: Write the failing tests**

```ts
it("spaces off: no spaces request and no spaceId", async () => {
  const seen = calls("GET");
  mount("/?space=SpEngNpQrSt2uVwX");
  await screen.findByText("Landing page");
  expect(seen.some((c) => c.path.startsWith("/api/v1/spaces"))).toBe(false);
  expect(seen.find((c) => c.path === "/api/v1/artifacts")!.search.get("spaceId")).toBeNull();
});

it("?space=Engineering requests scope=space", async () => {
  const seen = calls("GET");
  mountHosted("/?space=SpEngNpQrSt2uVwX");
  await screen.findByText("Meeting notes");
  const q = seen.find((c) => c.path === "/api/v1/artifacts")!.search;
  expect([q.get("scope"), q.get("spaceId")]).toEqual(["space", "SpEngNpQrSt2uVwX"]);
});

it("?space=<personal> requests scope=mine", async () => {
  const seen = calls("GET");
  mountHosted("/?space=Ab3dEfGhJk4mNpQr");
  await waitFor(() => expect(seen.find((c) => c.path === "/api/v1/artifacts")?.search.get("scope")).toBe("mine"));
});

it("an unknown space clears the param", async () => {
  const router = mountHosted("/?space=SpNopeNpQrSt9uVw");
  await waitFor(() => expect(router.state.location.search).toEqual({}));
});

it("search carries spaceId", async () => {
  const seen = calls("GET");
  mountHosted("/search?q=notes&space=SpEngNpQrSt2uVwX");
  await waitFor(() => expect(seen.find((c) => c.path === "/api/v1/search")?.search.get("spaceId")).toBe("SpEngNpQrSt2uVwX"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-library`
Expected: FAIL.

- [ ] **Step 3: Implement.** Space queries run only with the `spaces` feature.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-library library search`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(library): space filter in the URL and query`

### Task 6: Space switcher and space marker

**Depends on:** Task 5. **Blocked on D1, D2, D3.**

**Files:**
- Create: `apps/dashboard/src/spaces/SpaceSwitcher.tsx`, `spaces/SpaceMarker.tsx`, `apps/dashboard/e2e/spaces.spec.ts`
- Modify: `library/Library.tsx` (or `layout/AppLayout.tsx`, per D1), `library/ArtifactCard.tsx`, `library/ArtifactRow.tsx`, `viewer/TitleBar.tsx`, `e2e/library-layout.spec.ts`, `e2e/card-inset.spec.ts`
- Test: `apps/dashboard/test/spaces-library.test.tsx`

**Interfaces:**
- Consumes: `useCurrentSpace`, `useHosted`.
- Produces: `<SpaceSwitcher />`, `<SpaceMarker space={SpaceRef} />`.

- [ ] **Step 1: Write the failing tests**

```ts
it("switcher lists the personal space, then my shared spaces by name", async () => {
  mountHosted("/");
  const sw = await screen.findByRole("navigation", { name: "Spaces" }); // landmark per D1
  expect(within(sw).getAllByRole("link").map((l) => l.textContent)).toEqual(["My space", "Engineering", "Exec"]); // label per D2
});

it("switcher never shows Clients (admin view) or anyone else's personal space", async () => {
  mountHosted("/");
  const sw = await screen.findByRole("navigation", { name: "Spaces" });
  expect(within(sw).queryByText("Clients")).toBeNull();
  expect(within(sw).queryByText("Bob Builder")).toBeNull();
});

it("choosing Engineering navigates to ?space=", async () => {
  const router = mountHosted("/");
  fireEvent.click(await screen.findByRole("link", { name: "Engineering" }));
  await waitFor(() => expect(router.state.location.search).toEqual({ space: "SpEngNpQrSt2uVwX" }));
});

it("shared-space cards show the space and say Created by", async () => {
  mountHosted("/?space=SpEngNpQrSt2uVwX");
  const card = (await screen.findByText("Meeting notes")).closest("article")!;
  expect(within(card).getByText("Engineering")).toBeVisible();
  expect(within(card).getByText(/^Created by /)).toBeVisible();
});
// e2e/spaces.spec.ts (mock, /?hosted=1): switcher reachable by keyboard; 375 and 1280, light and dark
// library-layout.spec.ts, card-inset.spec.ts: hosted variants at 375 and 1280 keep today's measurements
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-library`
Expected: FAIL.

- [ ] **Step 3: Implement per D1 to D3.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-library && pnpm --filter @oa/dashboard test:e2e -- spaces library-layout card-inset`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(library): space switcher and space marker`

### Task 7: Pick a space when publishing

**Depends on:** Task 2. **Blocked on D4.**

**Files:**
- Create: `apps/dashboard/src/spaces/SpacePicker.tsx`
- Modify: `upload/uploadPipeline.ts:15,181`, `upload/UploadDialog.tsx`
- Test: `apps/dashboard/test/spaces-publish.test.tsx`

**Interfaces:**
- Consumes: `useHosted`, `canPublishTo`, `useCurrentSpace`.
- Produces: `uploadArtifact` input `spaceId?: string`, sent on create only; `<SpacePicker value={string | undefined} onChange={(id: string) => void} include={(s: MySpace | "personal") => boolean} label={string} />`.

- [ ] **Step 1: Write the failing tests**

```ts
// openUploadWith(files) drops files on the library drop zone, as dropzone.test.tsx does.

it("picker offers My space and Engineering, not Exec", async () => {
  mountHosted("/");
  await openUploadWith([new File(["# x"], "a.md")]);
  fireEvent.click(await screen.findByRole("combobox", { name: "Space" })); // control per D4
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["My space", "Engineering"]);
});

it("preselects My space when the library's space isn't publishable", async () => {
  mountHosted("/?space=SpExcNpQrSt3uVwX");
  await openUploadWith([new File(["# x"], "a.md")]);
  expect(await screen.findByRole("combobox", { name: "Space" })).toHaveTextContent("My space");
});

it("publish body carries spaceId", async () => {
  const seen = calls("POST");
  mountHosted("/?space=SpEngNpQrSt2uVwX");
  await openUploadWith([new File(["# x"], "a.md")]);
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  await waitFor(() => expect(seen.find((c) => c.path === "/api/v1/artifacts")?.body).toMatchObject({ spaceId: "SpEngNpQrSt2uVwX" }));
});

it("spaces off: no picker and no spaceId", async () => {
  const seen = calls("POST");
  mount("/");
  await openUploadWith([new File(["# x"], "a.md")]);
  expect(screen.queryByRole("combobox", { name: "Space" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  await waitFor(() => expect(seen.find((c) => c.path === "/api/v1/artifacts")?.body).not.toHaveProperty("spaceId"));
});

it("403 space_forbidden shows the server message in the dialog", async () => {
  server.use(http.post("*/api/v1/artifacts", () => HttpResponse.json({ error: { code: "space_forbidden", message: "server text" } }, { status: 403 })));
  mountHosted("/");
  await openUploadWith([new File(["# x"], "a.md")]);
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  expect(await within(screen.getByRole("dialog")).findByText("You can't publish to this space. Ask a space manager for editor access.")).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-publish`
Expected: FAIL.

- [ ] **Step 3: Implement per D4.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-publish upload dropzone`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(upload): choose a space when publishing`

### Task 8: Move an artifact to another shared space

**Depends on:** Tasks 2, 3, 7. **Blocked on D3, D4.**

**Files:**
- Create: `apps/dashboard/src/spaces/MoveDialog.tsx`
- Modify: `viewer/panels/Details.tsx`
- Test: `apps/dashboard/test/spaces-move.test.tsx`

**Interfaces:**
- Consumes: `useMoveArtifact`, `SpacePicker`, `canOf`, `canPublishTo`.
- Produces: `<MoveDialog artifact={ArtifactSummary} onClose={() => void} />`; targets are shared spaces only (never a personal space) and exclude the current one.

- [ ] **Step 1: Write the failing tests**

```ts
const NOTES = "De6gHjKmNp7qRsTu";
const OPS = { id: "SpOpsNpQrSt5uVwX", kind: "shared" as const, name: "Ops", publicLinks: false, myRole: "editor" as const };
const withOps = (m: Me) => ({ ...m, spaces: [...(m.spaces ?? []), OPS] });

it("Move shows when can.move", async () => {
  mountHosted(`/a/${NOTES}`);
  expect(await screen.findByRole("button", { name: "Move" })).toBeVisible();
});

it("targets are shared, publishable and not the current space", async () => {
  mountHosted(`/a/${NOTES}`, true, withOps);
  fireEvent.click(await screen.findByRole("button", { name: "Move" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Move to" }));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Ops"]); // not My space, Engineering or Exec
});

it("moving a public artifact into a public-off space warns first", async () => {
  server.use(http.get(`*${R.artifact(NOTES)}`, async ({ request }) => {
    const a = await (await fetch(request.url, { headers: { authorization: "Bearer mock" } })).json();
    return HttpResponse.json({ ...a, visibility: "public" });
  }));
  mountHosted(`/a/${NOTES}`, true, withOps);
  fireEvent.click(await screen.findByRole("button", { name: "Move" }));
  await chooseOption("Move to", "Ops");
  expect(screen.getByText("Ops doesn't allow public links. The artifact becomes visible to the team instead.")).toBeVisible(); // copy per D4
});

it("after a move the panel shows the new space", async () => {
  server.use(http.post(`*${R.moveArtifact(NOTES)}`, () => HttpResponse.json({ ...arts.find((a) => a.id === NOTES), space: { id: OPS.id, kind: "shared", name: "Ops", publicLinks: false } })));
  mountHosted(`/a/${NOTES}`, true, withOps);
  fireEvent.click(await screen.findByRole("button", { name: "Move" }));
  await chooseOption("Move to", "Ops");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("Ops")).toBeVisible();
});

it("space_forbidden keeps the dialog open with the message", async () => {
  server.use(http.post(`*${R.moveArtifact(NOTES)}`, () => HttpResponse.json({ error: { code: "space_forbidden", message: "server text" } }, { status: 403 })));
  mountHosted(`/a/${NOTES}`, true, withOps);
  fireEvent.click(await screen.findByRole("button", { name: "Move" }));
  await chooseOption("Move to", "Ops");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move" }));
  expect(await within(screen.getByRole("dialog")).findByText("You can't publish to this space. Ask a space manager for editor access.")).toBeVisible();
});
```

(`chooseOption(label, option)` opens the combobox named `label` and clicks `option`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-move`
Expected: FAIL.

- [ ] **Step 3: Implement per D3, D4.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-move`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(viewer): move an artifact to another space`

### Task 9: Public links off per space, in the Share panel

**Depends on:** Tasks 2, 3. **Blocked on D9.**

**Files:**
- Modify: `apps/dashboard/src/viewer/panels/Share.tsx:36-60,207-260`, `e2e/share-layout.spec.ts`
- Test: `apps/dashboard/test/share-public-off.test.tsx`

**Interfaces:**
- Consumes: `artifact.space.publicLinks`, `canOf(a).setVisibility`.

- [ ] **Step 1: Write the failing tests**

```ts
const full = { edit: true, share: true, setVisibility: true, delete: true, transfer: false, move: true, dataWrite: true };
const inExec = { ...arts[0], access: "manager", space: { id: "SpExcNpQrSt3uVwX", kind: "shared", name: "Exec", publicLinks: false }, can: full };
const serve = (a: object) => server.use(http.get(`*${R.artifact(arts[0].id)}`, () => HttpResponse.json(a)));

it("public is not selectable in a public-off space", async () => {
  serve(inExec);
  mount(`/a/${arts[0].id}`);
  await openShare();
  expect(await screen.findByRole("radio", { name: "Public" })).toBeDisabled(); // or absent, per D9
  expect(screen.getByText("Public links are turned off for this space.")).toBeVisible();
});

it("no space (self-hosted): Share panel unchanged", async () => {
  mount(`/a/${arts[0].id}`);
  await openShare();
  expect(await screen.findByRole("radio", { name: "Public" })).toBeEnabled();
  expect(screen.queryByText("Public links are turned off for this space.")).toBeNull();
});

it("a 403 public_links_off from a stale tab shows the space note and keeps the old visibility", async () => {
  serve({ ...arts[0], access: "manager", space: { id: "SpEngNpQrSt2uVwX", kind: "shared", name: "Engineering", publicLinks: true }, can: full, visibility: "team" });
  server.use(http.patch(`*${R.artifact(arts[0].id)}`, () => HttpResponse.json({ error: { code: "public_links_off", message: "Public links are off in this space" } }, { status: 403 })));
  mount(`/a/${arts[0].id}`);
  await openShare();
  fireEvent.click(await screen.findByRole("radio", { name: "Public" }));
  fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
  expect(await screen.findByText("Public links are turned off for this space.")).toBeVisible();
  expect(screen.getByRole("radio", { name: "Team" })).toBeChecked();
});

it("without setVisibility there is no visibility control", async () => {
  serve({ ...inExec, access: "editor", can: { ...full, share: false, setVisibility: false, delete: false, move: false } });
  mount(`/a/${arts[0].id}`);
  await openShare();
  expect(screen.queryByRole("radiogroup", { name: "Visibility" })).toBeNull();
});
// share-layout.spec.ts: hosted public-off variant keeps the panel layout at 375 and 1280
```

(`openShare()` clicks the title bar's Share button and waits for the panel.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- share-public-off`
Expected: FAIL.

- [ ] **Step 3: Implement per D9.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- share-public-off share && pnpm --filter @oa/dashboard test:e2e -- share-layout`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(share): respect a space's public-links setting`

### Task 10: Spaces admin page

**Depends on:** Task 2. **Blocked on D5, D9.**

**Files:**
- Create: `apps/dashboard/src/settings/spaces/Spaces.tsx`
- Modify: `router.tsx` (`/settings/spaces`; owner, admin, and members who manage a space), `settings/SettingsLayout.tsx` (tab "Spaces" with the `spaces` feature), `e2e/settings-layout.spec.ts`
- Test: `apps/dashboard/test/spaces-admin.test.tsx`

**Interfaces:**
- Consumes: `useSpaces({ kind: "shared" })`, `useCreateSpace`, `usePatchSpace`, `useDeleteSpace`, `useAddSelfToSpace`, `SPACE_MANAGER_FIELDS`, `errorCopy`.
- Produces: route `/settings/spaces?space=<id>`; hosts `<SpaceAccess space={Space} />` (Tasks 11, 12).

- [ ] **Step 1: Write the failing tests**

```ts
it("guests are redirected to /shared", async () => {
  const router = mountHosted("/settings/spaces", true, (m) => ({ ...m, user: { ...m.user, role: "guest" } }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/shared"));
});

it("without the spaces feature the route redirects", async () => {
  const router = mount("/settings/spaces");
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings/agents"));
});

it("an admin sees every shared space, never personal ones", async () => {
  mountHosted("/settings/spaces");
  const list = await screen.findByRole("list", { name: "Spaces" });
  expect(within(list).getAllByRole("heading").map((h) => h.textContent)).toEqual(["Clients", "Engineering", "Exec"]);
});

it("create trims the name and sends the defaults", async () => {
  const seen = calls("POST");
  mountHosted("/settings/spaces");
  fireEvent.click(await screen.findByRole("button", { name: "New space" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "  Design  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create space" }));
  await waitFor(() => expect(seen.find((c) => c.path === "/api/v1/spaces")?.body).toEqual({ name: "Design", allMembersRole: null, publicLinks: true }));
});

it("All members: None PATCHes allMembersRole null", async () => {
  const seen = calls("PATCH");
  mountHosted("/settings/spaces?space=SpEngNpQrSt2uVwX");
  await chooseOption("All members", "None");
  await waitFor(() => expect(seen.at(-1)).toEqual(expect.objectContaining({ path: "/api/v1/spaces/SpEngNpQrSt2uVwX", body: { allMembersRole: null } })));
});

it("a space manager who isn't an admin can rename and toggle public links only", async () => {
  mountHosted("/settings/spaces?space=SpEngNpQrSt2uVwX", true, (m) => ({ ...m, user: { ...m.user, role: "member" } }));
  expect(await screen.findByRole("textbox", { name: "Name" })).toBeEnabled();
  expect(screen.getByRole("switch", { name: "Public links" })).toBeEnabled();
  expect(screen.queryByRole("combobox", { name: "All members" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete space" })).toBeNull();
});

it("delete of a non-empty space shows the 409 message", async () => {
  mountHosted("/settings/spaces?space=SpEngNpQrSt2uVwX");
  fireEvent.click(await screen.findByRole("button", { name: "Delete space" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Move or delete this space's artifacts first, including the trash.");
});

it("an admin with no role in Clients can add themselves, which is recorded", async () => {
  const seen = calls("POST");
  mountHosted("/settings/spaces?space=SpCliNpQrSt4uVwX");
  fireEvent.click(await screen.findByRole("button", { name: "Add me to this space" })); // per D5
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Space managers are told, and it's recorded in the audit log.");
  await chooseOption("Your role", "Viewer");
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Add me" }));
  await waitFor(() => expect(seen.at(-1)).toEqual(expect.objectContaining({ path: "/api/v1/spaces/SpCliNpQrSt4uVwX/members/self", body: { role: "viewer" } })));
});

it("turning public links off warns that public artifacts become team", async () => {
  mountHosted("/settings/spaces?space=SpEngNpQrSt2uVwX");
  fireEvent.click(await screen.findByRole("switch", { name: "Public links" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Public artifacts in Engineering become visible to the team only.");
});
// settings-layout.spec.ts: Spaces tab present at /settings/profile?hosted=1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-admin`
Expected: FAIL.

- [ ] **Step 3: Implement per D5, D9.** The server's `space_not_empty` is the authority for delete.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-admin router`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): spaces admin page`

### Task 11: Map Google groups to space roles

**Depends on:** Task 10. **Blocked on D5.**

**Files:**
- Create: `apps/dashboard/src/settings/spaces/SpaceAccess.tsx`, `settings/spaces/GroupPicker.tsx`
- Test: `apps/dashboard/test/space-access.test.tsx`

**Interfaces:**
- Consumes: `useSpaceMappings`, `usePutMapping`, `useDeleteMapping`, `useDirectoryGroups`, `hasFeature(me, "sync_google")`.
- Produces: `<SpaceAccess space={Space} />`; `<GroupPicker label={string} onPick={(g: DirectoryGroup) => void} exclude={string[]} />` (`exclude` holds `groupId`s).

- [ ] **Step 1: Write the failing tests**

```ts
const ENG = "/settings/spaces?space=SpEngNpQrSt2uVwX";

it("lists Engineering's group mapping", async () => {
  mountHosted(ENG);
  const row = await screen.findByRole("row", { name: /eng@example.com/ });
  expect(row).toHaveTextContent("Engineering");
});

it("role choices are exactly Viewer, Editor, Manager", async () => {
  mountHosted(ENG);
  fireEvent.click(within(await screen.findByRole("row", { name: /eng@example.com/ })).getByRole("combobox", { name: "Role" }));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Viewer", "Editor", "Manager"]);
});

it("adding a group PUTs viewer keyed by groupId; mapped groups are excluded from the picker", async () => {
  const seen = calls("PUT");
  mountHosted(ENG);
  fireEvent.change(await screen.findByRole("combobox", { name: "Add a group" }), { target: { value: "sa" } });
  expect(await screen.findByRole("option", { name: /sales@example.com/ })).toBeVisible();
  expect(screen.queryByRole("option", { name: /eng@example.com/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /sales@example.com/ }));
  await waitFor(() => expect(seen.at(-1)).toEqual(expect.objectContaining({ path: "/api/v1/spaces/SpEngNpQrSt2uVwX/mappings/gSales03", body: { role: "viewer" } })));
});

it("frozen: no control adds or changes a mapping", async () => {
  mountHosted(ENG, { directory: "frozen" });
  await screen.findByRole("heading", { name: "Engineering" });
  expect(screen.queryByRole("combobox", { name: "Add a group" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Role" })).toBeNull();
});

it("a 409 directory_sync_off shows the message and restores the role", async () => {
  server.use(http.put("*/api/v1/spaces/:id/mappings/:g", () => HttpResponse.json({ error: { code: "directory_sync_off", message: "server text" } }, { status: 409 })));
  mountHosted(ENG);
  await chooseOption("Role", "Manager");
  expect(await screen.findByText("Directory sync is off, so groups can't be changed here.")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent("Editor"); // the mock maps eng@ as editor
});

it("mappings are hidden from space managers who aren't admins", async () => {
  mountHosted(ENG, true, (m) => ({ ...m, user: { ...m.user, role: "member" } }));
  await screen.findByRole("heading", { name: "Engineering" });
  expect(screen.queryByRole("table", { name: "Groups" })).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: FAIL.

- [ ] **Step 3: Implement per D5.** Role changes are optimistic (pattern `useOptimisticMembers`), restored on failure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): map directory groups to space roles`

### Task 12: Space members (manual, synced, frozen)

**Depends on:** Task 11. **Blocked on D6.**

**Files:**
- Modify: `apps/dashboard/src/settings/spaces/SpaceAccess.tsx`
- Test: `apps/dashboard/test/space-access.test.tsx`

**Interfaces:**
- Consumes: `useSpaceMembers`, `usePutSpaceMember`, `useDeleteSpaceMember`, `useMembers()`, `useHosted().tier`, `SpaceMember { userId, user, status, role, source, manualRole, syncRole, groups, cap }`.

- [ ] **Step 1: Write the failing tests**

```ts
const one = (m: object) => server.use(http.get("*/api/v1/spaces/:id/members", () => page([m], null)));
const bob = { id: "Bc4eFgHjKm5nPqRs", name: "Bob Builder", email: "bob@example.com" };

it("Ada is a hand-added manager of Engineering", async () => {
  mountHosted(ENG);
  const row = await screen.findByRole("row", { name: /Ada Lovelace/ });
  expect(row).toHaveTextContent("Manager");
  expect(row).toHaveTextContent("Added by hand"); // copy per D6
});

it("giving synced Bob a manual role PUTs it keyed by user id", async () => {
  const seen = calls("PUT");
  mountHosted(ENG);
  await chooseOption("Role for Bob Builder", "Manager");
  await waitFor(() => expect(seen.at(-1)).toEqual(expect.objectContaining({ path: "/api/v1/spaces/SpEngNpQrSt2uVwX/members/Bc4eFgHjKm5nPqRs", body: { role: "manager" } })));
});

it("synced-only rows name their groups and offer no remove", async () => {
  one({ userId: bob.id, user: bob, status: "active", role: "viewer", source: "sync", manualRole: null, syncRole: "viewer", groups: [{ groupId: "gEng01", email: "eng@example.com", name: "Engineering" }], cap: null });
  mountHosted(ENG);
  const row = await screen.findByRole("row", { name: /Bob Builder/ });
  expect(row).toHaveTextContent("eng@example.com");
  expect(within(row).queryByRole("button", { name: "Remove" })).toBeNull();
});

it("capped members say they can only view", async () => {
  one({ userId: bob.id, user: bob, status: "active", role: "editor", source: "manual", manualRole: "editor", syncRole: null, groups: [], cap: "restricted" });
  mountHosted(ENG);
  expect(await screen.findByText("Can only view (restricted group)")).toBeVisible();
});

it("guests can be given Viewer only", async () => {
  one({ userId: "gst1", user: { id: "gst1", name: null, email: "guest@client.com" }, status: "active", role: "viewer", source: "manual", manualRole: "viewer", syncRole: null, groups: [], cap: "guest" });
  mountHosted(ENG);
  fireEvent.click(within(await screen.findByRole("row", { name: /guest@client.com/ })).getByRole("combobox", { name: "Role" }));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Viewer"]);
});

it("frozen on Team: the banner names Business and never says sync resumes", async () => {
  mountHosted(ENG, { tier: "team", directory: "frozen" });
  const banner = await screen.findByRole("status", { name: "Membership frozen" });
  expect(banner).toHaveTextContent("Group sync is part of Business."); // copy per D6
  expect(banner.textContent).not.toMatch(/resume/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: FAIL on the member cases.

- [ ] **Step 3: Implement per D6.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): space members, manual and synced`

### Task 13: Transfer a departed person's personal artifacts

**Depends on:** Task 2. **Blocked on D7.**

**Files:**
- Create: `apps/dashboard/src/settings/Transfer.tsx`
- Modify: `settings/Members.tsx`, `e2e/invite-link.spec.ts`
- Test: `apps/dashboard/test/transfer.test.tsx`

**Interfaces:**
- Consumes: `useMembers("suspended,removed")`, `useTransferSummary`, `useRunTransfer`, `useSpaces({ kind: "shared" })`.
- Produces: `<TransferDialog member={Member} onClose={() => void} />`; `runAll(run: (i: TransferInput) => Promise<TransferResult>, to: TransferInput["to"], onProgress: (moved: number, remaining: number) => void): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

```ts
const CAROL = "Cr7tNpQrSt8uVwXy";
const openFor = async (name: string) => {
  fireEvent.click(within(await screen.findByRole("row", { name: new RegExp(name) })).getByRole("button", { name: "Transfer artifacts" }));
  return screen.findByRole("dialog");
};

it("Carol (suspended) offers Transfer; Bob (active) doesn't", async () => {
  mountHosted("/settings/members");
  expect(within(await screen.findByRole("row", { name: /Carol Departed/ })).getByRole("button", { name: "Transfer artifacts" })).toBeVisible();
  expect(within(screen.getByRole("row", { name: /Bob Builder/ })).queryByRole("button", { name: "Transfer artifacts" })).toBeNull();
});

it("the dialog shows counts, never titles", async () => {
  mountHosted("/settings/members");
  const d = await openFor("Carol Departed");
  expect(await within(d).findByText("2 artifacts, 1 in trash")).toBeVisible();
});

it("transfer never requests Carol's artifacts", async () => {
  const seen = calls("GET");
  mountHosted("/settings/members");
  await openFor("Carol Departed");
  await screen.findByText("2 artifacts, 1 in trash");
  expect(seen.some((c) => c.path === "/api/v1/artifacts" || c.path === "/api/v1/search" || c.search.get("spaceId") === CAROL)).toBe(false);
});

it("successors exclude Carol, guests and restricted Dan", async () => {
  mountHosted("/settings/members");
  await openFor("Carol Departed");
  fireEvent.click(screen.getByRole("combobox", { name: "Give them to" }));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Ada Lovelace", "Bob Builder"]);
});

it("runAll loops until nextCursor is null", async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ moved: 100, remaining: 20, nextCursor: "c1" })
    .mockResolvedValueOnce({ moved: 20, remaining: 0, nextCursor: null });
  const progress = vi.fn();
  await expect(runAll(run, { kind: "space", spaceId: "SpEngNpQrSt2uVwX" }, progress)).resolves.toBe(120);
  expect(run.mock.calls.map((c) => c[0].cursor)).toEqual([undefined, "c1"]);
  expect(progress.mock.calls).toEqual([[100, 20], [120, 0]]);
});

it("reopening after a partial run shows the fresh counts", async () => {
  let n = 0;
  server.use(http.get(`*${R.memberTransfer(CAROL)}`, () => HttpResponse.json(n++ === 0 ? { live: 2, deleted: 1 } : { live: 1, deleted: 0 })));
  mountHosted("/settings/members");
  const d = await openFor("Carol Departed");
  fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
  const again = await openFor("Carol Departed");
  expect(await within(again).findByText("1 artifact")).toBeVisible();
});

it("400 invalid_successor shows the copy", async () => {
  server.use(http.post(`*${R.memberTransfer(CAROL)}`, () => HttpResponse.json({ error: { code: "invalid_successor", message: "server text" } }, { status: 400 })));
  mountHosted("/settings/members");
  const d = await openFor("Carol Departed");
  await chooseOption("Give them to", "Bob Builder");
  fireEvent.click(within(d).getByRole("button", { name: "Transfer 3 artifacts" }));
  expect(await within(d).findByText("Choose an active member who isn't a guest or restricted.")).toBeVisible();
});

it("409 member_active shows the copy", async () => {
  server.use(http.post(`*${R.memberTransfer(CAROL)}`, () => HttpResponse.json({ error: { code: "member_active", message: "server text" } }, { status: 409 })));
  mountHosted("/settings/members");
  const d = await openFor("Carol Departed");
  await chooseOption("Give them to", "Bob Builder");
  fireEvent.click(within(d).getByRole("button", { name: "Transfer 3 artifacts" }));
  expect(await within(d).findByText("This person is active again, so their artifacts stay with them.")).toBeVisible();
});
// invite-link.spec.ts: hosted Members page (with Carol's row) keeps the invite link layout
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- transfer`
Expected: FAIL.

- [ ] **Step 3: Implement per D7.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- transfer members && pnpm --filter @oa/dashboard test:e2e -- invite-link`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): transfer a departed person's artifacts`

### Task 14: Hosted sign-in page (Google, emailed codes, Turnstile slot)

**Depends on:** Task 2. **Blocked on D8.**

**Files:**
- Modify: `apps/dashboard/src/pages/SignIn.tsx`, `pages/NoAccess.tsx` (direct mode redirects to `/sign-in?error=no_access`), `router.tsx:153-155` (pass `error`, `next`), `e2e/m1-a11y.spec.ts`, `e2e/m2-a11y.spec.ts`, `e2e/m2-hostile.spec.ts`
- Create: `apps/dashboard/src/pages/CodeSignIn.tsx`, `pages/Turnstile.tsx`, `apps/dashboard/e2e/signin-hosted.spec.ts`
- Test: `apps/dashboard/test/signin-hosted.test.tsx`

**Interfaces:**
- Consumes: `useAuthProviders`, `requestCode`, `verifyCode`, `normalizeCode`, `CODE_POLICY`, `SignInError`.
- Produces: `SignIn({ error?: string; next?: string })`; `<CodeSignIn next={string | undefined} turnstileSiteKey={string | undefined} />`; `<Turnstile siteKey={string} onToken={(t: string | null) => void} />` (loads `https://challenges.cloudflare.com/turnstile/v0/api.js` once, renders `data-testid="turnstile"` with `data-sitekey`; nothing without a key).

- [ ] **Step 1: Write the failing tests**

```ts
// requestThroughUi(email): types "Work email", clicks "Email me a code", waits for "8-digit code".
// typeCode(c): fills "8-digit code", clicks "Sign in".
// turnstileCallback(t): calls the onToken the window.turnstile stub captured.

it("providers 404 renders today's page", async () => {
  server.use(http.get("*/auth/providers", () => new HttpResponse(null, { status: 404 })));
  mount("/sign-in");
  expect(await screen.findByRole("link", { name: "Continue with Cloudflare Access" })).toHaveAttribute("href", "/auth/login");
});

it("access mode renders today's page", async () => {
  mountHosted("/sign-in", { mode: "access" });
  expect(await screen.findByRole("link", { name: "Continue with Cloudflare Access" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Email me a code" })).toBeNull();
});

it("direct: Google navigates to its start with next; no Access or self-hosted copy", async () => {
  mountHosted("/sign-in?next=%2Fa%2FDe6gHjKmNp7qRsTu");
  expect(await screen.findByRole("link", { name: "Continue with Google" })).toHaveAttribute("href", "/auth/login/google?next=%2Fa%2FDe6gHjKmNp7qRsTu");
  expect(screen.queryByText(/Cloudflare Access/)).toBeNull();
  expect(screen.queryByText("Self-hosted on Cloudflare")).toBeNull();
});

it.each([
  ["tenant", "Use your @example.com Google account."],
  ["identity_conflict", "This Google account was replaced. Ask an admin to reset your sign-in."],
  ["removed", "Your access to this workspace was removed."],
  ["no_access", "This account doesn't have access yet. Ask an admin to invite you."],
  ["expired", "That sign-in took too long. Try again."],
  ["failed", "Sign-in didn't finish. Try again."],
])("error=%s", async (error, copy) => {
  mountHosted(`/sign-in?error=${error}`);
  expect(await screen.findByRole("alert")).toHaveTextContent(copy); // copy per D8
});

it("empty providers says sign-in is not set up", async () => {
  server.use(http.get("*/auth/providers", () => HttpResponse.json({ mode: "direct", providers: [] })));
  mount("/sign-in");
  expect(await screen.findByText("Sign-in isn't set up yet. Ask your admin.")).toBeVisible();
});

it("request shows the masked address, resend timer and expiry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mountHosted("/sign-in");
  await requestThroughUi("bob@example.com");
  expect(screen.getByText("If b***@example.com can sign in here, we sent it a code.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Resend in 60s" })).toBeDisabled();
  expect(screen.getByText("The code works for 10 minutes.")).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole("button", { name: "Resend code" })).toBeEnabled();
  vi.useRealTimers();
});

it.each(["2468-1357", "2468 1357", " 24681357 "])("code %j verifies and navigates to next", async (typed) => {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...location, assign });
  mountHosted("/sign-in?next=%2Fmine");
  await requestThroughUi("bob@example.com");
  await typeCode(typed);
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/mine"));
  vi.unstubAllGlobals();
});

it("a short code is refused before sending", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in");
  await requestThroughUi("bob@example.com");
  await typeCode("246813");
  expect(await screen.findByText("Enter all 8 digits.")).toBeVisible();
  expect(seen.some((c) => c.path === "/auth/code/verify")).toBe(false);
});

it("invalid_code shows attempts left and clears the code", async () => {
  mountHosted("/sign-in");
  await requestThroughUi("bob@example.com");
  await typeCode("11111111");
  expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't work. 4 tries left.");
  expect(screen.getByRole("textbox", { name: "8-digit code" })).toHaveValue("");
});

it("the fifth wrong code expires it", async () => {
  mountHosted("/sign-in");
  await requestThroughUi("bob@example.com");
  for (let i = 0; i < 5; i++) await typeCode("11111111");
  expect(await screen.findByRole("alert")).toHaveTextContent("That code expired. Send a new one.");
});

it("no_pending returns to the email step with the email kept", async () => {
  server.use(http.post("*/auth/code/verify", () => HttpResponse.json({ error: { code: "unauthorized", message: "Start over", details: { reason: "no_pending" } } }, { status: 401 })));
  mountHosted("/sign-in");
  await requestThroughUi("bob@example.com");
  await typeCode("24681357");
  expect(await screen.findByRole("textbox", { name: "Work email" })).toHaveValue("bob@example.com");
});

it("rate_limited shows the wait", async () => {
  server.use(http.post("*/auth/code/request", () => HttpResponse.json({ error: { code: "rate_limited", message: "Too many", details: { retryAfter: 3600, scope: "email" } } }, { status: 429, headers: { "Retry-After": "3600" } })));
  mountHosted("/sign-in");
  fireEvent.change(await screen.findByRole("textbox", { name: "Work email" }), { target: { value: "bob@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Too many codes requested. Try again in 60 minutes.");
});

it("Turnstile slot renders with a site key and sends the token", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in", { turnstile: true });
  expect(await screen.findByTestId("turnstile")).toHaveAttribute("data-sitekey", "1x00000000000000000000AA");
  act(() => turnstileCallback("tok-1"));
  await requestThroughUi("bob@example.com");
  expect(seen.find((c) => c.path === "/auth/code/request")!.body).toEqual({ email: "bob@example.com", turnstileToken: "tok-1" });
});

it("no site key: no widget and no token", async () => {
  const seen = calls("POST");
  mountHosted("/sign-in");
  await requestThroughUi("bob@example.com");
  expect(screen.queryByTestId("turnstile")).toBeNull();
  expect(seen.find((c) => c.path === "/auth/code/request")!.body).toEqual({ email: "bob@example.com" });
});

it("turnstile_failed keeps the email and resets the widget", async () => {
  mountHosted("/sign-in", { turnstile: true });
  await screen.findByTestId("turnstile");
  act(() => turnstileCallback("fail"));
  fireEvent.change(screen.getByRole("textbox", { name: "Work email" }), { target: { value: "bob@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Verification failed. Try again.");
  expect(screen.getByRole("textbox", { name: "Work email" })).toHaveValue("bob@example.com");
});

it("turnstile_required shows at the slot and sends nothing more", async () => {
  mountHosted("/sign-in", { turnstile: true });
  await screen.findByTestId("turnstile");
  fireEvent.change(screen.getByRole("textbox", { name: "Work email" }), { target: { value: "bob@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
  const slot = screen.getByTestId("turnstile").parentElement!;
  expect(await within(slot).findByText("Complete the verification first.")).toBeVisible();
});

it("a locked verify (429, scope ip) shows the wait", async () => {
  server.use(http.post("*/auth/code/verify", () => HttpResponse.json({ error: { code: "rate_limited", message: "Locked", details: { retryAfter: 900, scope: "ip" } } }, { status: 429, headers: { "Retry-After": "900" } })));
  mountHosted("/sign-in");
  await requestThroughUi("bob@example.com");
  await typeCode("24681357");
  expect(await screen.findByRole("alert")).toHaveTextContent("Too many tries from this network. Try again in 15 minutes.");
});

it("direct mode: /no-access redirects to /sign-in?error=no_access", async () => {
  const router = mountHosted("/no-access");
  await waitFor(() => expect(router.state.location.href).toBe("/sign-in?error=no_access"));
});

it("Access mode keeps today's /no-access page", async () => {
  mount("/no-access");
  expect(await screen.findByRole("heading", { name: "You're signed in, but there's nothing here for you yet" })).toBeVisible();
});

it("no copy contains an em dash", async () => {
  mountHosted("/sign-in?error=tenant");
  await screen.findByRole("alert");
  expect(document.body.textContent).not.toContain("\u2014");
});
// m1-a11y.spec.ts, m2-a11y.spec.ts: axe and keyboard pass for /sign-in?hosted=1, its code step, and ?error=tenant
// m2-hostile.spec.ts: a hostile email (bidi override, 300 chars, "<script>") shows the field error and never renders markup; a hostile next ("//evil.example") is never navigated to
// e2e/signin-hosted.spec.ts: 375 and 1280, light and dark; signin-split.spec.ts unedited
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- signin-hosted`
Expected: FAIL.

- [ ] **Step 3: Implement per D8.** Code field: `inputMode="numeric"`, `autoComplete="one-time-code"`, placeholder `1234 5678` built from `codeLength`; the client check is the contract's `normalizeCode`; Google is a full-page navigation to the provider's `start` plus `?next=`; on verify success, `location.assign(next)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- signin-hosted && pnpm --filter @oa/dashboard test:e2e -- signin m1-a11y m2-a11y m2-hostile`
Expected: PASS: `signin-split` (unedited), `signin-hosted`, `m1-a11y`, `m2-a11y`, `m2-hostile`.

- [ ] **Step 5: Commit** `feat(sign-in): hosted Google and emailed-code sign-in`

### Task 15: Restricted members (manual flag; group restrictions shown)

**Depends on:** Task 2. **Blocked on D14.**

**Files:**
- Modify: `apps/dashboard/src/settings/Members.tsx`, `settings/spaces/SpaceAccess.tsx` (the `cap: "restricted"` marker links here), `e2e/invite-link.spec.ts` (hosted row actions)
- Test: `apps/dashboard/test/restricted.test.tsx`

**Interfaces:**
- Consumes: `useMembers()`, `Member.restriction`, `useSetRestricted`, `errorCopy`.
- Produces: `restrictionLabel(r: Restriction | null | undefined): string | null` → `null`; `"Restricted"` (manual only); `"Restricted via Contractors"` (groups, names joined with ", "); `"Restricted (by hand and via Contractors)"` (both).

- [ ] **Step 1: Write the failing tests**

```ts
const DAN = "Dn8uPqRsTu9vWxYz";

it("restrictionLabel", () => {
  const con = { groupId: "gCon04", email: "contractors@example.com", name: "Contractors" };
  expect(restrictionLabel(null)).toBeNull();
  expect(restrictionLabel({ manual: true, groups: [] })).toBe("Restricted");
  expect(restrictionLabel({ manual: false, groups: [con] })).toBe("Restricted via Contractors");
  expect(restrictionLabel({ manual: true, groups: [con] })).toBe("Restricted (by hand and via Contractors)");
});

it("Dan shows as restricted via Contractors, with no clear control for the group", async () => {
  mountHosted("/settings/members");
  const row = await screen.findByRole("row", { name: /Dan Contractor/ });
  expect(row).toHaveTextContent("Restricted via Contractors");
  expect(within(row).queryByRole("button", { name: "Lift restriction" })).toBeNull();
});

it("an admin restricts Bob by hand: confirm, then PUT", async () => {
  const seen = calls("PUT");
  mountHosted("/settings/members");
  fireEvent.click(within(await screen.findByRole("row", { name: /Bob Builder/ })).getByRole("button", { name: "Restrict" })); // control per D14
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Bob Builder will only be able to view, everywhere, and can't create artifacts.");
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restrict" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe("/api/v1/members/Bc4eFgHjKm5nPqRs/restricted"));
  expect(await screen.findByRole("row", { name: /Bob Builder/ })).toHaveTextContent("Restricted");
});

it("lifting a manual restriction DELETEs and leaves group restrictions in place", async () => {
  const seen = calls("DELETE");
  mountHosted("/settings/members", true);
  // restrict Dan by hand first (PUT), then:
  fireEvent.click(within(await screen.findByRole("row", { name: /Dan Contractor/ })).getByRole("button", { name: "Restrict" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restrict" }));
  fireEvent.click(within(await screen.findByRole("row", { name: /Restricted \(by hand and via Contractors\)/ })).getByRole("button", { name: "Lift manual restriction" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Lift" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe(`/api/v1/members/${DAN}/restricted`));
  expect(await screen.findByRole("row", { name: /Dan Contractor/ })).toHaveTextContent("Restricted via Contractors");
});

it("works in frozen and Team installs (manual flag, any sync mode)", async () => {
  mountHosted("/settings/members", { tier: "team", directory: "frozen" });
  expect(within(await screen.findByRole("row", { name: /Bob Builder/ })).getByRole("button", { name: "Restrict" })).toBeEnabled();
});

it("never offered on the owner, on guests, or without the spaces feature", async () => {
  mountHosted("/settings/members");
  expect(within(await screen.findByRole("row", { name: /Ada Lovelace/ })).queryByRole("button", { name: "Restrict" })).toBeNull();
  // self-hosted: mount("/settings/members") shows no Restrict button on any row
});
// invite-link.spec.ts: hosted Members rows with the Restrict control keep the layout at 375 and 1280
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- restricted`
Expected: FAIL.

- [ ] **Step 3: Implement per D14.** The space members list (Task 12) shows `cap: "restricted"` with `restrictionLabel` from the matching `Member`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- restricted members && pnpm --filter @oa/dashboard test:e2e -- invite-link`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): restrict a member by hand; show group restrictions`

### Task 16: Reset a member's Google link

**Depends on:** Task 2. **Blocked on D11.**

**Files:**
- Modify: `apps/dashboard/src/settings/Members.tsx`, `e2e/invite-link.spec.ts` (hosted row actions)
- Test: `apps/dashboard/test/reset-identity.test.tsx`

**Interfaces:**
- Consumes: `useResetIdentity`, `Member.identities`, `me.user.role`.

- [ ] **Step 1: Write the failing tests**

```ts
const reset = (row: HTMLElement) => within(row).queryByRole("button", { name: "Reset Google sign-in" });

it("offered on members with a Google link, never on the owner", async () => {
  mountHosted("/settings/members");
  expect(reset(await screen.findByRole("row", { name: /Carol Departed/ }))).toBeVisible();
  expect(reset(screen.getByRole("row", { name: /Ada Lovelace/ }))).toBeNull(); // owner
  expect(reset(screen.getByRole("row", { name: /Bob Builder/ }))).toBeNull(); // identities: []
});

it("confirm, then DELETE", async () => {
  const seen = calls("DELETE");
  mountHosted("/settings/members");
  fireEvent.click(reset(await screen.findByRole("row", { name: /Carol Departed/ }))!);
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reset" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe("/api/v1/members/Cr7tNpQrSt8uVwXy/identities/google"));
});

it("404 says there was nothing to reset", async () => {
  server.use(http.delete("*/api/v1/members/:id/identities/google", () => HttpResponse.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })));
  mountHosted("/settings/members");
  fireEvent.click(reset(await screen.findByRole("row", { name: /Carol Departed/ }))!);
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reset" }));
  expect(await screen.findByText("There was no Google sign-in to reset.")).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- reset-identity`
Expected: FAIL.

- [ ] **Step 3: Implement per D11.** Non-admins never reach `/settings/members` (existing gate).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- reset-identity members && pnpm --filter @oa/dashboard test:e2e -- invite-link`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): reset a member's Google sign-in`

### Task 17: Directory page: connect, status, Sync now, disconnect (FinQore)

**Depends on:** Tasks 2, 4. **Blocked on D12.**

**Files:**
- Create: `apps/dashboard/src/settings/Directory.tsx`, `apps/dashboard/e2e/directory.spec.ts`
- Modify: `router.tsx` (`/settings/directory`, owner and admin), `settings/SettingsLayout.tsx` (tab "Directory" with the `spaces` feature)
- Test: `apps/dashboard/test/directory.test.tsx`

**Interfaces:**
- Consumes: `useDirectory`, `useDirectorySync`, `useDisconnectDirectory`, `R.directoryConnect`, `DirectoryConnectError`.

- [ ] **Step 1: Write the failing tests**

```ts
it("owner sees the binding and a healthy status", async () => {
  mountHosted("/settings/directory");
  expect(await screen.findByText("example.com")).toBeVisible();
  expect(screen.getByText("Connected by ada@example.com")).toBeVisible();
  expect(screen.getByRole("status", { name: "Sync status" })).toHaveTextContent("Healthy");
});

it("mode off: the owner connects through a full-page link", async () => {
  mountHosted("/settings/directory", { directory: "off" });
  expect(await screen.findByRole("link", { name: "Connect Google Workspace" })).toHaveAttribute("href", "/api/v1/directory/connect");
});

it("admins see status but no Sync now or Disconnect", async () => {
  mountHosted("/settings/directory", true, (m) => ({ ...m, user: { ...m.user, role: "admin" } }));
  await screen.findByRole("status", { name: "Sync status" });
  for (const name of ["Sync now", "Disconnect"]) expect(screen.queryByRole("button", { name })).toBeNull();
});

it("?connected=1 shows success", async () => {
  mountHosted("/settings/directory?connected=1");
  expect(await screen.findByText("Google Workspace connected.")).toBeVisible();
});

it.each([
  ["not_super_admin", "Connect with a Google super admin account."],
  ["domain_mismatch", "That Google Workspace isn't example.com."],
  ["customer_mismatch", "That Google Workspace belongs to a different organization."],
  ["scopes", "Allow every requested permission, then try again."],
  ["denied", "Google access was declined."],
  ["expired", "The connection took too long. Try again."],
  ["failed", "Couldn't connect. Try again."],
])("?error=%s", async (error, copy) => {
  mountHosted(`/settings/directory?error=${error}`);
  expect(await screen.findByRole("alert")).toHaveTextContent(copy); // copy per D12
});

it("unhealthy shows Retrying and the last error", async () => {
  mountHosted("/settings/directory", { unhealthy: true });
  const s = await screen.findByRole("status", { name: "Sync status" });
  expect(s).toHaveTextContent("Retrying");
  expect(s).toHaveTextContent("Google returned 503");
});

it("Sync now POSTs", async () => {
  const seen = calls("POST");
  mountHosted("/settings/directory");
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe("/api/v1/directory/sync"));
});

it("Sync now while sync is off shows the directory_sync_off copy", async () => {
  server.use(http.post("*/api/v1/directory/sync", () => HttpResponse.json({ error: { code: "directory_sync_off", message: "server text" } }, { status: 409 })));
  mountHosted("/settings/directory");
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(await screen.findByText("Directory sync is off, so groups can't be changed here.")).toBeVisible();
});

it("Disconnect warns that memberships freeze and nobody loses access", async () => {
  mountHosted("/settings/directory");
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Space memberships stay as they are and are managed by hand. Nobody loses access.");
});

it("reauth_required offers a fresh Google sign-in back to this page", async () => {
  mountHosted("/settings/directory");
  server.use(http.get("*/api/v1/directory", () => HttpResponse.json({ error: { code: "reauth_required", message: "Sign in again" } }, { status: 401 })));
  expect(await screen.findByText("For your security, sign in with Google again to manage the directory.")).toBeVisible();
  expect(screen.getByRole("link", { name: "Sign in with Google again" })).toHaveAttribute("href", "/auth/login/google?next=%2Fsettings%2Fdirectory");
});
// e2e/directory.spec.ts (mock, ?hosted=1 and ?hosted=unhealthy): 375 and 1280, light and dark, keyboard
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- directory`
Expected: FAIL.

- [ ] **Step 3: Implement per D12.** Status labels by `SyncStatus.state`: `ok` "Healthy", `backoff` "Retrying", `auth_failed` "Google access lost", `customer_mismatch` "Wrong Google Workspace", `never` "Not synced yet". A `reauth_required` on any directory call shows the reauth link instead of the page.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- directory router && pnpm --filter @oa/dashboard test:e2e -- directory settings-layout`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): Google directory page`

### Task 18: Held sweeps and restricted groups (FinQore)

**Depends on:** Task 17. **Blocked on D12.**

**Files:**
- Modify: `apps/dashboard/src/settings/Directory.tsx`
- Test: `apps/dashboard/test/directory.test.tsx`

**Interfaces:**
- Consumes: `SyncStatus.held: HeldSweep[]`, `useConfirmHeld`, `useRestrictedGroups`, `usePutRestrictedGroup`, `useDeleteRestrictedGroup`, `GroupPicker`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a held sweep says how many would lose access", async () => {
  mountHosted("/settings/directory");
  const held = await screen.findByRole("region", { name: "Waiting for your confirmation" });
  expect(held).toHaveTextContent("Sales (sales@example.com)");
  expect(held).toHaveTextContent("4 of 4 members would lose access");
});

it("the owner applies a held sweep", async () => {
  const seen = calls("POST");
  mountHosted("/settings/directory");
  fireEvent.click(within(await screen.findByRole("region", { name: "Waiting for your confirmation" })).getByRole("button", { name: "Apply" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove 4 people" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe("/api/v1/directory/held/gSales03/confirm"));
});

it("admins see held sweeps but can't apply them", async () => {
  mountHosted("/settings/directory", true, (m) => ({ ...m, user: { ...m.user, role: "admin" } }));
  const held = await screen.findByRole("region", { name: "Waiting for your confirmation" });
  expect(within(held).queryByRole("button", { name: "Apply" })).toBeNull();
});

it("restricted groups list Contractors and add through the group picker", async () => {
  const seen = calls("PUT");
  mountHosted("/settings/directory");
  expect(await screen.findByRole("row", { name: /contractors@example.com/ })).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Add a restricted group" }), { target: { value: "sa" } });
  fireEvent.click(await screen.findByRole("option", { name: /sales@example.com/ }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe("/api/v1/directory/restricted-groups/gSales03"));
});

it("frozen: no new restricted groups, but an existing one can be lifted", async () => {
  const seen = calls("DELETE");
  mountHosted("/settings/directory", { directory: "frozen" });
  const row = await screen.findByRole("row", { name: /contractors@example.com/ });
  expect(screen.queryByRole("combobox", { name: "Add a restricted group" })).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: "Lift" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Lift restriction" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe("/api/v1/directory/restricted-groups/gCon04"));
});

it("adding a restricted group while off shows the directory_sync_off copy", async () => {
  server.use(http.put("*/api/v1/directory/restricted-groups/:g", () => HttpResponse.json({ error: { code: "directory_sync_off", message: "server text" } }, { status: 409 })));
  mountHosted("/settings/directory");
  fireEvent.change(await screen.findByRole("combobox", { name: "Add a restricted group" }), { target: { value: "sa" } });
  fireEvent.click(await screen.findByRole("option", { name: /sales@example.com/ }));
  expect(await screen.findByText("Directory sync is off, so groups can't be changed here.")).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- directory`
Expected: FAIL on the held and restricted cases.

- [ ] **Step 3: Implement per D12.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- directory`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): held sweeps and restricted groups`

### Task 19: Real end-to-end suite on a hosted-mode server

**Depends on:** Tasks 3 to 18; Backend P2 and P3 merged; staging with test hooks on.

Adds one case for restriction: `test("a restricted member sees no Create artifact control and the API refuses a create")` (session for a member of `gCon04`; expect `page.getByRole("button", { name: "Create artifact" })` to have count 0 and `POST /api/v1/artifacts` to answer 403 `space_forbidden`).

**Files:**
- Create: `apps/dashboard/e2e/real/spaces.spec.ts`
- Modify: `apps/dashboard/e2e/real/consent.spec.ts` (direct-mode variant), `e2e/real/fixtures.ts` (`hostedSession(input: TestSessionInput): Promise<string>` via `TEST_HOOKS` session, returning the cookie; `latestCode(email: string): Promise<string>` via `TEST_HOOKS` otp latest)
- Test: the specs themselves

**Interfaces:**
- Consumes: real endpoints; `TEST_HOOKS`, `TestSessionInput`, `OtpLatestInput`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a space viewer sees no edit controls and the API refuses a publish", async ({ page, request }) => {
  const cookie = await hostedSession({ email: `viewer-${uniq()}@${DOMAIN}`, role: "member", spaces: [{ spaceId: ENG, role: "viewer" }] });
  await page.context().addCookies([toCookie(cookie)]);
  await page.goto(`/a/${engArtifact}`);
  await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
  const res = await request.post(`/api/v1/artifacts/${engArtifact}/versions`, { headers: { cookie, "X-OA-Request": "1" }, data: { content: "x" } });
  expect(res.status()).toBe(404);
});

test("an admin never sees another person's personal artifacts", async ({ page }) => {
  const cookie = await hostedSession({ email: `admin-${uniq()}@${DOMAIN}`, role: "admin" });
  await page.context().addCookies([toCookie(cookie)]);
  const asked = page.waitForRequest((r) => r.url().includes(`spaceId=${bobId}`)).then(() => true, () => false);
  await page.goto(`/?space=${bobId}`);
  await expect(page).toHaveURL(/\/$/);
  expect(await Promise.race([asked, page.waitForTimeout(1000).then(() => false)])).toBe(false);
});

test("an editor publishes into Engineering and moves it to Exec", async ({ page }) => {
  const cookie = await hostedSession({ email: `ed-${uniq()}@${DOMAIN}`, role: "member", spaces: [{ spaceId: ENG, role: "editor" }, { spaceId: EXEC, role: "editor" }] });
  await page.context().addCookies([toCookie(cookie)]);
  await page.goto(`/?space=${ENG}`);
  await uploadMarkdown(page, "move-me.md");
  await page.getByRole("button", { name: "Move" }).click();
  await page.getByRole("combobox", { name: "Move to" }).click();
  await page.getByRole("option", { name: "Exec" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move" }).click();
  await expect(page.getByText("Exec")).toBeVisible();
});

test("public links off: Share can't make it public; /full shows NotPublic", async ({ page, browser }) => {
  // manager of EXEC (publicLinks false) opens Share: "Public" disabled; an anonymous context on /a/<id>/full sees "This artifact isn't public"
});

test("transfer moves a removed person's artifacts to a successor", async ({ page }) => {
  // admin opens Members, Transfer on the removed fixture user, picks the successor, confirms; the summary then reads "0 artifacts"
});

test("an invited guest signs in with an 8-digit code and sees no edit controls", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Work email" }).fill(guestEmail);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const code = await latestCode(guestEmail);
  expect(code).toMatch(/^\d{8}$/);
  await page.getByRole("textbox", { name: "8-digit code" }).fill(`${code.slice(0, 4)} ${code.slice(4)}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto(`/a/${sharedWithGuest}`);
  await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
});
// consent.spec.ts: "direct mode: an MCP connector popup signs in through /sign-in and reaches consent"
```

The two outlined tests follow the same pattern: a `hostedSession` cookie, one navigation, and assertions on the exact strings from Tasks 9 and 13.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test:e2e:real -- spaces consent`
Expected: FAIL until server and UI are both in place.

- [ ] **Step 3: Fix drift**: dashboard-side here; server or shared fixes go to Backend as an issue linked from this PR.

- [ ] **Step 4: Run twice with parallel workers**

Run: `pnpm --filter @oa/dashboard test:e2e:real -- spaces consent --repeat-each=2`
Expected: PASS.

- [ ] **Step 5: Commit** `test(e2e): hosted spaces and direct sign-in on a real server`

---

## Self-review

- **Spec coverage:** 4.1 sign-in → 14 (Google, codes, Turnstile slot, every error, `/no-access` redirect), 16 (identity reset), 19 (real run with consent). 4.2 spaces and personal space → 5, 6; roles → 1, 11, 12; "All members" → 10; ownership (managers act, personal owners transfer) → 3, 8; personal private from admins → 6, 10, 13, 19; departed transfer → 13; visibility and public links per space → 9, 10; contractors and guests read-only including data writes → 3, 12, 15 (manual and group restriction), 18, 19. 4.3 step 3 (connect IdP, map groups) → 17, 11, in M1 for FinQore. 4.5 tier and frozen sync, never widens access → 11, 12, 18; Team copy from `instance.tier` → 12. Sync health → 4, 17. Out of scope: single-artifact transfer UI; audit log (M4).
- **Contract fidelity:** every route, field and error code is PR #359's at `ed1105c` (groups by `groupId`, `Member.restriction`, `R.memberRestricted`, `R.spaceMemberSelf`, `public_links_off`, no `outsideSharing`); each of the 11 hosted error codes has an owning task and a tested UI string; mock values (ids, names, counts, code, masked email, site key, held sweep) are the mock store's. No mismatches.
- **Review must-fixes:** SPA-owned sign-in; 8-digit codes through `normalizeCode`; verify `{ code }` plus cookie; 202 request and 401 reasons; all six `SignInError` values; `AuthProviders`; `Me.auth`, `instance.hosted`, `instance.signIn`; identity reset UI; every refusal on `/sign-in?error=` (the `/no-access` page redirects in direct mode); every space shape from the contract; directory connect, status and held in M1 (17, 18); Review Focus 1 consistent with Task 14; tests carry real assertions.
- **Rulings:** `can` read directly (Task 3; fallback is the contract's own function); `can.dataWrite` drives data-write UI; `manager` access; 409 `directory_sync_off`; moves into personal spaces refused; `spaceId` create-only; sync-health banner; opt-in mocks.
- **Boundary:** no task lists a file under `packages/shared` or `apps/server`.
- **Parallelism and specs:** the table matches each Depends on line; each of the 13 touched specs has one owning task.
- **Type consistency:** `features`, `hasFeature`, `canOf`, `readAuthProviders`, `mountHosted`, `calls`, `parseHostedParam`, `useHosted`, `canPublishTo`, `accessLabel`, `useCurrentSpace`, `SpacePicker`, `runAll`, `requestCode`, `verifyCode`, `Turnstile`, `GroupPicker`, `errorCopy`, `restrictionLabel`, `useSetRestricted`, `useAddSelfToSpace` have one signature each.
