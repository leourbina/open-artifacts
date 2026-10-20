# Hosted M1 P4: Spaces in the app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard shows spaces (library, publish, move), gives admins a page to map Google groups (or, on Team, people) to spaces with viewer, editor and manager roles, lets admins transfer a departed person's personal artifacts, and offers a hosted sign-in page (Google plus emailed codes), while a self-hosted install looks and behaves exactly as today.

**Architecture:** Every hosted feature is gated on new optional `Me` fields (`me.spaces`, `me.hosted`, `me.authProvider`) or, signed out, on `/auth/providers`, so an older or self-hosted server renders today's UI unchanged. Permissions come from a new server-computed `artifact.can` block (fallback: today's `access`), read through one helper so no component decides edit rights itself. Contract schemas, routes and MSW handlers land first in `@oa/shared` so every UI task is test-first against mocks; the real suite follows once Backend P2/P3 ship.

**Tech Stack:** React 19, TanStack Router and Query, `@oa/ui` and `@oa/ui/shadcn`, zod, MSW (`@oa/shared/mocks`), vitest plus Testing Library, Playwright (mock config and `playwright.real.config.ts`).

**Spec:** `docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md` on `origin/docs/hosted-design` (PR #350), sections 4.1 (sign-in), 4.2 (RBAC), 4.3, 4.5 (tier rules). Roadmap: https://artifacts.leourbina.com/a/axtJ4ieni2LsKfTk (M1, P4; depends on P2 and P3).

## Global Constraints

- Copy: no em dashes in any user-facing string; say "any AI agent".
- Self-hosted is unchanged: with `me.spaces` and `me.hosted` absent or null and `/auth/providers` absent or `mode: "access"`, no new control renders and `/sign-in` is today's Access page (existing `e2e/signin-split.spec.ts` stays green unedited).
- Personal artifacts belong to the person: admins can't browse or read them. The UI never lists, links or requests another user's personal space or its artifacts; a transfer shows a count only.
- Read-only is enforced on the server; the UI must not offer edit, rename, restore, publish-to, move, share or delete to a role that lacks it (read from `artifactCan`, Task 3).
- A tier change never widens access: in frozen or manual mode the UI offers no control that adds a group, and copy never implies sync will resume on its own.
- Public no-sign-in links can be turned off per space; when off, the UI never offers "public".
- Roles per space are exactly `viewer`, `editor`, `manager`; "All members" is a built-in group (id `all_members`) that can't be deleted, only given a role or none.
- Emailed codes: guests are read-only; the sign-in page never reveals whether an address is invited (same response for every address).
- New `Me`/`ArtifactSummary` fields are `.optional()` so older servers still parse (pattern: `MeSchema.instance.update`).
- Visual choices are Design's: tasks marked **Blocked on D#** start only after the user picks that option. Logic, data and tests in those tasks may be written first against a neutral placeholder layout that uses existing `@oa/ui` primitives.
- No `git stash`. One PR per task (or per small group), through the merge queue.

## Review Focus

1. **A self-hosted instance after upgrade** (spaces off, Access sign-in): a person expects nothing new to appear and no request to `/api/v1/spaces` or `/auth/providers` to fire. Pinned in Task 1 (`me without hosted fields parses`) and Task 4 (`spaces off: no spaces request, no switcher`).
2. **A viewer of a space opening an artifact**: expects no rename, restore, publish, move, share or delete affordance anywhere (viewer, panels, library card menu, upload drop), and a stale tab that tries anyway gets a toast, not a crash. Pinned in Task 3 (`viewer sees no edit affordance`, `403 forbidden on rename toasts`).
3. **An admin handling a departed person**: expects to see how many personal artifacts await transfer, never their titles, and can't pick the departed person as the successor. Pinned in Task 12 (`transfer never requests the person's artifacts`, `successor list excludes the departed`).
4. **Emailed code typos and abuse**: a code pasted with spaces or a dash, a wrong or expired code, or a burst of resends (429) should each give a clear, non-enumerating message and keep the email filled in. Pinned in Task 13 (`code normalizes spaces and dashes`, `invalid_code`, `rate_limited`, `same screen for unknown address`).
5. **Space settings edge cases**: deleting a non-empty space (409), demoting the last manager, or turning public links off while artifacts are public should show the server's message and leave the UI consistent with the server after refetch. Pinned in Task 9 (`delete non-empty space shows 409 message`) and Task 8 (`public off: existing public artifact shows the space note`).

---

## Contracts we need from Backend

No hosted P2 or P3 plan exists yet (`git ls-tree origin/main docs/superpowers/plans` has only the 2026-10-18 plans; no open PR). P4 assumes the shapes below; each is **pending Backend P2/P3**. Task 1 adds them to `@oa/shared` as the proposal; when Backend's plan lands, Task 1 is reconciled to Backend's exact shapes before any later task merges.

**Me additions** (pending P2/P3). Field names `me.spaces`, `me.hosted`, `me.authProvider` are Backend's (coordinator, 2026-10-20); the shapes are P4's proposal until P2/P3 publish their "API contract for P4". All optional at the top level of `MeSchema`:

```ts
spaces: z.array(SpaceRefSchema.extend({ myRole: SpaceRoleSchema })).nullable().optional(),
  // absent or null: RBAC off (self-hosted default). Else my memberships, my personal space included (kind "personal").
hosted: z.object({
  tier: z.enum(["trial", "team", "business"]),
  directory: z.object({                                       // null: no IdP connected yet
    provider: z.enum(["google"]),
    mode: z.enum(["sync", "manual", "frozen"]),               // frozen = Team after sync
    lastSyncAt: z.string().nullable(),
    error: z.string().nullable(),
  }).nullable(),
}).nullable().optional(),                                     // absent or null: not a hosted install
authProvider: z.enum(["access", "google", "email_code", "dev"]).optional(), // how this session signed in
```
Spaces gate on `me.spaces`, not `me.hosted`: the spec puts RBAC in the open-source product behind config, so a self-hoster may turn it on.

**Spaces** (pending P3):

```ts
SpaceRoleSchema = z.enum(["viewer", "editor", "manager"]);
SpaceRefSchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(["personal", "shared"]), publicLinks: z.boolean() });
SpaceSchema = SpaceRefSchema.extend({ myRole: SpaceRoleSchema.nullable(), artifactCount: z.number().int(), createdAt: z.string() });
SpaceCreateSchema = z.strictObject({ name: z.string().trim().min(1).max(80) });
SpacePatchSchema = z.strictObject({ name: ..., publicLinks: z.boolean() }).partial();
```
- `GET /api/v1/spaces` -> `Space[]`: my personal space plus every shared space I hold a role in; owner/admin also get every shared space (`myRole` may be null). Never another user's personal space.
- `POST /api/v1/spaces` (owner/admin) -> `Space`. `PATCH /api/v1/spaces/:id` (admin or space manager) -> `Space`. `DELETE /api/v1/spaces/:id` (admin) -> 204; 409 `conflict` when `artifactCount > 0`; personal spaces 400.

**Space access** (pending P3):

```ts
GroupGrantSchema = z.object({ groupId: z.string(), name: z.string(), email: z.string().nullable(), role: SpaceRoleSchema, builtIn: z.boolean() });
MemberGrantSchema = z.object({ userId: z.string(), email: z.string(), name: z.string().nullable(), role: SpaceRoleSchema, source: z.enum(["manual", "frozen"]) });
SpaceAccessSchema = z.object({ groups: z.array(GroupGrantSchema), members: z.array(MemberGrantSchema) });
DirectoryGroupSchema = z.object({ id: z.string(), name: z.string(), email: z.string(), memberCount: z.number().int().nullable() });
```
- `GET /api/v1/spaces/:id/access` (admin, or manager read-only) -> `SpaceAccess`. "All members" is always in `groups` with `builtIn: true` (role may be absent from the list meaning no access; proposal: present with its role, removed by `DELETE`).
- `PUT /api/v1/spaces/:id/groups/:groupId` `{ role }` -> `GroupGrant`; `DELETE` -> 204. 409 `conflict` when `me.hosted.directory.mode !== "sync"` (except `all_members`).
- `PUT /api/v1/spaces/:id/members/:userId` `{ role }` -> `MemberGrant`; `DELETE` -> 204. Allowed in `manual` and `frozen` modes; 409 in `sync`.
- `GET /api/v1/directory/groups?q=` (admin) -> `DirectoryGroup[]` (max 20, prefix match on name or email).

**Artifacts** (pending P3):
- `ArtifactSummarySchema` gains `space: SpaceRefSchema.nullable().optional()` and `can: z.object({ edit, share, move, delete: z.boolean() }).optional()`.
- `ListQuerySchema` gains `space: z.string().optional()` (a space id; `personal` alias = my personal space). Search (`R.search`) takes the same `space` filter.
- `PublishShape` gains `spaceId: IdSchema.optional()` (default: my personal space). 403 `forbidden` when not editor or manager there.
- `POST /api/v1/artifacts/:id/move` `{ spaceId }` -> `ArtifactSummary`. Needs `can.move` on the artifact and editor or manager on the target. When the target has `publicLinks: false`, a public artifact becomes `team` (response shows it).
- `PATCH artifact { visibility: "public" }` in a space with `publicLinks: false` -> 403 `forbidden`.

**Departed people and transfer** (pending P3):
- `MemberSchema` gains `status: z.enum(["active", "suspended", "removed"]).optional()` and `pendingTransfer: z.number().int().optional()` (count of personal artifacts awaiting transfer; only for owner/admin callers).
- `POST /api/v1/members/:id/transfer` `{ to: { kind: "user", userId } | { kind: "space", spaceId } }` (owner/admin) -> `{ moved: number }`. 400 when `userId` is the departed person or a guest; 409 when the person is still `active`. This is the departed bulk transfer.
- Single transfer: `POST /api/v1/artifacts/:id/transfer` with the same `to` -> `ArtifactSummary`, for the owner of a personal artifact handing it on. P4 uses only the bulk form; the single form is listed so the shapes line up, with no P4 UI (add a task if the user wants it).

**Sign-in** (pending P2):
- `GET /auth/providers` (public, no session) -> `AuthProvidersSchema = z.object({ mode: z.enum(["access", "direct"]), google: z.boolean(), emailCode: z.boolean() })`.
- `AUTH.google = "/auth/google"`: GET, redirects to Google; returns to `/sign-in?error=domain` when `hd` doesn't match, `?error=1` otherwise.
- `POST /auth/email-code` `{ email }` -> 204 for every well-formed address (no enumeration); 429 `rate_limited` with `Retry-After`.
- `POST /auth/email-code/verify` `{ email, code }` (code: 6 digits) -> 204 plus session cookie; 400 `invalid_code` (wrong or expired, one message); 429 `rate_limited`.
- New error codes in `errors.ts`: `forbidden` (403, a role too low for a write; today's owner-only routes keep answering 404) and `invalid_code` (400). `conflict` and `rate_limited` already exist.

## Design options needed

Each is a question for Design, who produce options; the user picks. Tasks marked blocked wait on the pick.

- **D1 Space switcher**: where and how a person moves between spaces (sidebar list, library header dropdown, or a tab strip replacing All / Mine / Shared / Team), and how it coexists with today's scope tabs.
- **D2 Personal space**: its name ("My space", "Personal", the person's name), icon, and position relative to shared spaces.
- **D3 Space marker**: how an artifact's space shows on cards, rows, the viewer title bar or crumbs, and search hits.
- **D4 Space picker**: the control in the Create artifact dialog and in the Move dialog (select, combobox, or list), what's preselected, and how "you can't publish here" spaces appear (hidden vs disabled with a reason).
- **D5 Spaces admin page**: layout of `/settings/spaces` (list plus detail, or one card per space), the group-to-role row, the role picker, adding a group (search field), and how "All members" reads.
- **D6 Manual and frozen modes**: how Team tier's hand-managed members and a frozen sync list are presented (banner wording and placement, the member row, the "frozen at last sync" marker).
- **D7 Transfer**: where departed people show (badge on Members rows vs a separate "Departed" card), and the transfer dialog (successor person vs a space, confirmation copy).
- **D8 Hosted sign-in**: Google button, the emailed-code two-step (email then code), code entry (one field vs six boxes), error and resend states, and the brand panel footer for hosted ("Self-hosted on Cloudflare" must not show).
- **D9 Public links off**: how the Share panel shows "public" when the space disallows it (hidden, or disabled with a note), and the space-level toggle on the admin page.
- **D10 Read-only signal**: whether viewers get an explicit "View only" marker in the viewer, or simply no edit controls.

---

## File Structure

`packages/shared/src`
- `schemas.ts` (modify): the contract schemas above.
- `routes.ts` (modify): `R.spaces`, `R.space`, `R.spaceAccess`, `R.spaceGroup`, `R.spaceMember`, `R.directoryGroups`, `R.move`, `R.memberTransfer`; `AUTH.providers`, `AUTH.google`, `AUTH.emailCode`, `AUTH.emailCodeVerify`.
- `mocks/fixtures.ts`, `mocks/handlers.ts` (modify): spaces fixtures and handlers; `MockOptions.hosted?: boolean` turns the hosted `Me` fields on.

`apps/dashboard/src`
- `api/queries.ts` (modify): space, access, directory, move, transfer hooks and `qk` keys.
- `api/auth.ts` (create): sign-in calls (`useAuthProviders`, `startEmailCode`, `verifyEmailCode`); separate because they run signed out.
- `auth/permissions.ts` (create): `artifactCan`, `canPublishTo`, `useHosted`.
- `spaces/` (create): `SpacePicker.tsx`, `SpaceSwitcher.tsx`, `SpaceMarker.tsx`, `MoveDialog.tsx`, `useCurrentSpace.ts`.
- `settings/spaces/` (create): `Spaces.tsx` (page), `SpaceAccess.tsx` (groups and members editor), `GroupSearch.tsx`.
- `settings/Transfer.tsx` (create): transfer dialog; `settings/Members.tsx` (modify): departed status.
- `pages/SignIn.tsx` (modify): branch on providers; `pages/EmailCode.tsx` (create): the two-step code form.
- `library/Library.tsx`, `library/useLibraryQuery.ts`, `router.tsx`, `upload/UploadDialog.tsx`, `upload/uploadPipeline.ts`, `viewer/TitleBar.tsx`, `viewer/panels/{Details,Versions,Share}.tsx`, `settings/SettingsLayout.tsx` (modify).

Tests: `packages/shared/test/hosted-schemas.test.ts`; `apps/dashboard/test/{hosted-queries,permissions,spaces-library,spaces-publish,spaces-move,share-public-off,spaces-admin,space-access,transfer,signin-hosted}.test.tsx`; `apps/dashboard/e2e/{spaces,signin-hosted}.spec.ts`; `apps/dashboard/e2e/real/spaces.spec.ts`.

---

### Task 1: Contracts in `@oa/shared` (schemas, routes, mocks)

**Files:**
- Modify: `packages/shared/src/schemas.ts`, `packages/shared/src/routes.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/mocks/fixtures.ts`, `packages/shared/src/mocks/handlers.ts`
- Test: `packages/shared/test/hosted-schemas.test.ts`, `packages/shared/test/mocks.test.ts`

**Interfaces:**
- Produces: every schema and route in "Contracts we need from Backend", exported from `@oa/shared` with types (`Space`, `SpaceRef`, `MySpace`, `SpaceRole`, `SpaceAccess`, `GroupGrant`, `MemberGrant`, `DirectoryGroup`, `ArtifactCan`, `AuthProviders`, `TransferInput`, `TransferResult`); `fixtures.spaces: Space[]` (personal `sp_personal_ada`, shared `sp_eng` editor, `sp_exec` viewer, `sp_clients` manager with `publicLinks: false`); `createHandlers({ hosted: true })` (sets `me.spaces`, `me.hosted` with directory mode `sync`, `me.authProvider: "google"`).

- [ ] **Step 1: Write the failing tests**

```ts
test("me without hosted fields parses", () => {
  const me = MeSchema.parse(fixtures.me);
  expect([me.spaces, me.hosted, me.authProvider]).toEqual([undefined, undefined, undefined]);
});
test("artifact without space or can parses", () => {
  expect(ArtifactSummarySchema.parse(fixtures.artifacts[0]).can).toBeUndefined();
});
test("space roles are exactly viewer, editor, manager", () => {
  expect(SpaceRoleSchema.options).toEqual(["viewer", "editor", "manager"]);
});
test("transfer target is a user or a space", () => {
  expect(TransferInputSchema.safeParse({ to: { kind: "user", userId: "u1" } }).success).toBe(true);
  expect(TransferInputSchema.safeParse({ to: { kind: "group", id: "g" } }).success).toBe(false);
});
test("routes encode ids", () => {
  expect(R.spaceGroup("sp 1", "g/1")).toBe("/api/v1/spaces/sp%201/groups/g%2F1");
  expect(R.move("a1")).toBe("/api/v1/artifacts/a1/move");
});
// mocks.test.ts
test("hosted spaces list never includes another user's personal space", async () => {
  const list = await getJson("/api/v1/spaces", { hosted: true });
  expect(list.filter((s) => s.kind === "personal").map((s) => s.id)).toEqual(["sp_personal_ada"]);
});
test("mock move into a public-off space downgrades public to team", ...);
test("mock email-code returns 204 for any address", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/shared test -- hosted-schemas mocks`
Expected: FAIL, `SpaceRoleSchema` not exported.

- [ ] **Step 3: Implement the schemas, routes, error codes, fixtures and handlers**

Fields optional as listed. Handlers keep state in the existing per-`createHandlers` closure, enforce the 409s and the public-off downgrade, and serve `/auth/providers` as `{ mode: hosted ? "direct" : "access", google: hosted, emailCode: hosted }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/shared test && pnpm -r typecheck`
Expected: PASS; no type errors in server or dashboard.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(shared): hosted spaces, RBAC and direct sign-in contracts (pending Backend P2/P3)"
```

### Task 2: Query hooks and sign-in calls

**Files:**
- Modify: `apps/dashboard/src/api/queries.ts`
- Create: `apps/dashboard/src/api/auth.ts`
- Test: `apps/dashboard/test/hosted-queries.test.tsx`, `apps/dashboard/test/qk.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas and routes.
- Produces:
  - `qk.spaces = ["spaces"]`, `qk.spaceAccess(id) = ["spaces", id, "access"]`, `qk.directoryGroups(q) = ["directory", "groups", q]`.
  - `useSpaces(opts?: { enabled?: boolean })`, `useCreateSpace()`, `usePatchSpace(id)`, `useDeleteSpace()`, `useSpaceAccess(id)`, `usePutGroupGrant(spaceId)` (`{ groupId, role }`), `useDeleteGroupGrant(spaceId)`, `usePutMemberGrant(spaceId)` (`{ userId, role }`), `useDeleteMemberGrant(spaceId)`, `useDirectoryGroups(q: string)` (enabled when `q.trim().length >= 2`), `useMoveArtifact(id)` (`spaceId: string`), `useTransfer(memberId)` (`TransferInput`).
  - `api/auth.ts`: `useAuthProviders()`, `startEmailCode(email: string): Promise<void>`, `verifyEmailCode(email: string, code: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("move invalidates the artifact, the library and spaces", async () => {
  // spy qc.invalidateQueries; expect keys qk.artifact(id), ["artifacts"], qk.spaces
});
it("group grant failure toasts the server message", ...);  // "Couldn't change access." + description
it("directory search waits for two characters", ...);        // no request for "e", one for "en"
it("verifyEmailCode sends X-OA-Request and JSON body", ...);
it("useAuthProviders treats a 404 as access mode", ...);    // older server: { mode: "access", google: false, emailCode: false }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- hosted-queries qk`
Expected: FAIL, hooks not exported.

- [ ] **Step 3: Implement the hooks** with `useInvalidating` (existing) and the failure titles: "Couldn't create the space.", "Couldn't save the space.", "Couldn't delete the space.", "Couldn't change access.", "Couldn't move the artifact.", "Couldn't transfer the artifacts." Space-access mutations invalidate `qk.spaceAccess(id)` and `qk.spaces`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- hosted-queries qk`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(dashboard): space, access, move, transfer and sign-in hooks`

### Task 3: One permission helper; viewers never see edit

**Files:**
- Create: `apps/dashboard/src/auth/permissions.ts`
- Modify: `apps/dashboard/src/viewer/TitleBar.tsx:142-143`, `apps/dashboard/src/viewer/panels/Details.tsx:29-30`, `apps/dashboard/src/viewer/panels/Versions.tsx:22`, `apps/dashboard/src/viewer/panels/Share.tsx:109`
- Test: `apps/dashboard/test/permissions.test.tsx`

**Interfaces:**
- Produces:
  - `artifactCan(a: ArtifactSummary): ArtifactCan` → `a.can` when present, else `{ edit: access !== "viewer", share: access === "owner", move: access === "owner", delete: access === "owner" }`.
  - `canPublishTo(s: Space): boolean` → `s.kind === "personal" || s.myRole === "editor" || s.myRole === "manager"`.
  - `useHosted(): { spaces: MySpace[] | null; hosted: NonNullable<Me["hosted"]> | null; authProvider: Me["authProvider"] | null }` from `useMe` (each null when absent). `MySpace` is the `me.spaces` element type.

- [ ] **Step 1: Write the failing tests**

```ts
it("fallback matches today's access rules", () => {
  expect(artifactCan({ ...a, access: "editor" })).toEqual({ edit: true, share: false, move: false, delete: false });
});
it("server can wins over access", () => {
  expect(artifactCan({ ...a, access: "editor", can: { edit: true, share: true, move: true, delete: true } }).share).toBe(true);
});
it("viewer sees no edit affordance", async () => {
  // artifact with can all false; mount /a/:id
  // expect no "Rename", "Restore", "Publish new version", "Delete", "Save visibility", "Move" controls
});
it("space manager who is not owner can change visibility", ...); // can.share true, access "editor"
it("403 forbidden on rename toasts and keeps the old title", ...);
it("canPublishTo excludes viewer and roleless spaces", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- permissions`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `permissions.ts` and replace the four `access` checks** with `artifactCan(artifact).edit` / `.share` / `.delete`. No visual change.

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

Run: `pnpm --filter @oa/dashboard test`
Expected: PASS, including `share.test.tsx`, `versions.test.tsx`, `shell.test.tsx` unchanged.

- [ ] **Step 5: Commit** `refactor(dashboard): one artifactCan helper for edit rights`

### Task 4: Library space filter (URL and query plumbing)

**Files:**
- Modify: `apps/dashboard/src/router.tsx` (library `validateSearch`), `apps/dashboard/src/library/useLibraryQuery.ts`, `apps/dashboard/src/library/Library.tsx`
- Create: `apps/dashboard/src/spaces/useCurrentSpace.ts`
- Test: `apps/dashboard/test/spaces-library.test.tsx`

**Interfaces:**
- Consumes: `useSpaces`, `useHosted`.
- Produces: library search param `space?: string`; `LibraryFilters.space?: string` sent as `?space=`; `useCurrentSpace(): { space: Space | null; spaces: Space[]; set(id: string | undefined): void }` (unknown id in the URL resolves to `null` and clears the param).

- [ ] **Step 1: Write the failing tests**

```ts
it("spaces off: no spaces request, no switcher", async () => {
  mount("/"); await screen.findByText("Landing page");
  expect(seen.some((u) => u.pathname === R.spaces)).toBe(false);
});
it("?space=sp_eng filters the list", ...);        // request has space=sp_eng
it("unknown space id clears the param", ...);      // ?space=sp_nope → URL without space, list unfiltered
it("filters persist when switching space", ...);   // format=html kept
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-library`
Expected: FAIL on the `space=` request.

- [ ] **Step 3: Implement** `validateSearch` passes `space` through `str()`; `useSpaces({ enabled: useHosted().spaces !== null })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-library library`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(library): space filter in the URL and query`

### Task 5: Space switcher and space marker

**Blocked on D1, D2, D3.**

**Files:**
- Create: `apps/dashboard/src/spaces/SpaceSwitcher.tsx`, `apps/dashboard/src/spaces/SpaceMarker.tsx`
- Modify: `apps/dashboard/src/library/Library.tsx` (or `layout/AppLayout.tsx`, per D1), `library/ArtifactCard.tsx`, `library/ArtifactRow.tsx`, `viewer/TitleBar.tsx` (per D3)
- Test: `apps/dashboard/test/spaces-library.test.tsx`, `apps/dashboard/e2e/spaces.spec.ts`

**Interfaces:**
- Consumes: `useCurrentSpace`, `Space`, `SpaceRef`.
- Produces: `<SpaceSwitcher />` (no props; reads and sets the URL), `<SpaceMarker space={SpaceRef} />`.

- [ ] **Step 1: Write the failing tests**

```ts
it("switcher lists my personal space first, then shared spaces by name", ...);
it("switcher never shows another user's personal space", ...); // fixtures include none; assert only one personal
it("choosing a space navigates to ?space=<id>", ...);
it("cards show their space when spaces are on", ...);
// e2e/spaces.spec.ts (mock): switcher keyboard reachable; marker visible at 375 and 1280 widths, light and dark
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-library`
Expected: FAIL, switcher not rendered.

- [ ] **Step 3: Implement per the D1 to D3 picks.** Label for the personal space per D2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-library && pnpm --filter @oa/dashboard test:e2e -- spaces`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(library): space switcher and space marker`

### Task 6: Pick a space when publishing

**Blocked on D4.**

**Files:**
- Create: `apps/dashboard/src/spaces/SpacePicker.tsx`
- Modify: `apps/dashboard/src/upload/uploadPipeline.ts:15,181`, `apps/dashboard/src/upload/UploadDialog.tsx`
- Test: `apps/dashboard/test/spaces-publish.test.tsx`

**Interfaces:**
- Consumes: `useSpaces`, `canPublishTo`, `useCurrentSpace`.
- Produces: `uploadArtifact` input gains `spaceId?: string` (sent as `spaceId` on the publish body only when set); `<SpacePicker value={string | undefined} onChange={(id: string) => void} filter={(s: Space) => boolean} label={string} />`.

- [ ] **Step 1: Write the failing tests**

```ts
it("picker offers only personal, editor and manager spaces", ...); // sp_exec (viewer) absent or disabled per D4
it("preselects the library's current space when publishable, else personal", ...);
it("publish body carries spaceId", ...);
it("spaces off: no picker and no spaceId in the body", ...);
it("403 forbidden from publish shows the server message in the dialog", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-publish`
Expected: FAIL.

- [ ] **Step 3: Implement** the picker and thread `spaceId` through `uploadArtifact`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-publish upload dropzone`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(upload): choose a space when publishing`

### Task 7: Move an artifact to another space

**Blocked on D3, D4.**

**Files:**
- Create: `apps/dashboard/src/spaces/MoveDialog.tsx`
- Modify: `apps/dashboard/src/viewer/panels/Details.tsx` (entry point; placement per D3)
- Test: `apps/dashboard/test/spaces-move.test.tsx`

**Interfaces:**
- Consumes: `useMoveArtifact`, `SpacePicker`, `artifactCan`, `canPublishTo`.
- Produces: `<MoveDialog artifact={ArtifactSummary} onClose={() => void} />`.

- [ ] **Step 1: Write the failing tests**

```ts
it("Move shows only when can.move", ...);
it("target list excludes the current space and non-publishable spaces", ...);
it("moving into a public-off space warns that the public link stops working", ...); // copy per D4
it("after move the panel shows the new space and visibility from the response", ...);
it("409 or 403 keeps the dialog open with the server message", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-move`
Expected: FAIL.

- [ ] **Step 3: Implement** the dialog; confirm button disabled until a target is picked.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-move`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(viewer): move an artifact to another space`

### Task 8: Public links off per space, in the Share panel

**Blocked on D9.**

**Files:**
- Modify: `apps/dashboard/src/viewer/panels/Share.tsx:36-60,207-260`
- Test: `apps/dashboard/test/share-public-off.test.tsx`

**Interfaces:**
- Consumes: `artifact.space?.publicLinks`, `artifactCan`.

- [ ] **Step 1: Write the failing tests**

```ts
it("public is not selectable when the space turned public links off", ...);
it("public off: existing public artifact shows the space note", ...); // server may already have downgraded; show what the summary says
it("no space (self-hosted): Share panel unchanged", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- share-public-off`
Expected: FAIL.

- [ ] **Step 3: Implement per D9.** Note copy (proposal, Design may change): "Public links are turned off for this space."

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- share-public-off share`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(share): respect a space's public-links setting`

### Task 9: Spaces admin page (list, create, rename, delete, public links)

**Blocked on D5, D9.**

**Files:**
- Create: `apps/dashboard/src/settings/spaces/Spaces.tsx`
- Modify: `apps/dashboard/src/router.tsx` (`gated("/settings/spaces", ADMINS, "/settings/agents", Spaces)`), `apps/dashboard/src/settings/SettingsLayout.tsx` (tab "Spaces", roles owner/admin, shown only when `useHosted().spaces !== null`)
- Test: `apps/dashboard/test/spaces-admin.test.tsx`

**Interfaces:**
- Consumes: `useSpaces`, `useCreateSpace`, `usePatchSpace`, `useDeleteSpace`, `SettingsCard`, `MEASURE`.
- Produces: route `/settings/spaces`; `Spaces` lists shared spaces only and hosts `<SpaceAccess spaceId />` (Task 10) for the selected one.

- [ ] **Step 1: Write the failing tests**

```ts
it("members and guests are redirected away", ...);              // member → /settings/agents, guest → /shared
it("tab hidden and route redirects when spaces are off", ...);
it("lists shared spaces only, never personal ones", ...);
it("create trims the name and refuses empty", ...);
it("delete non-empty space shows 409 message", ...);
it("public links toggle PATCHes publicLinks", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- spaces-admin`
Expected: FAIL.

- [ ] **Step 3: Implement per D5.** Delete confirms through `AlertDialog`; disabled when `artifactCount > 0` is not assumed, the server's 409 is the authority.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- spaces-admin router`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): spaces admin page`

### Task 10: Map Google groups to space roles (sync mode)

**Blocked on D5.**

**Files:**
- Create: `apps/dashboard/src/settings/spaces/SpaceAccess.tsx`, `apps/dashboard/src/settings/spaces/GroupSearch.tsx`
- Test: `apps/dashboard/test/space-access.test.tsx`

**Interfaces:**
- Consumes: `useSpaceAccess`, `usePutGroupGrant`, `useDeleteGroupGrant`, `useDirectoryGroups`, `useHosted().hosted?.directory`.
- Produces: `<SpaceAccess spaceId={string} />` (renders the Task 11 manual editor when `hosted.directory?.mode !== "sync"`), `<GroupSearch onPick={(g: DirectoryGroup) => void} exclude={string[]} />`.

- [ ] **Step 1: Write the failing tests**

```ts
it("All members is always listed and can't be removed, only set to a role or no access", ...);
it("role choices are exactly Viewer, Editor, Manager", ...);
it("adding a group PUTs its role; already-mapped groups are excluded from search", ...);
it("removing a group asks for confirmation then DELETEs", ...);
it("shows last sync time and a sync error from me.hosted.directory", ...);
it("no directory connected: group search is absent and says to connect Google", ...); // copy per D5
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: FAIL.

- [ ] **Step 3: Implement per D5.** Role change is optimistic (pattern: `useOptimisticMembers`), restored on failure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): map directory groups to space roles`

### Task 11: Manual members mode (Team tier, frozen sync)

**Blocked on D6.**

**Files:**
- Modify: `apps/dashboard/src/settings/spaces/SpaceAccess.tsx`
- Test: `apps/dashboard/test/space-access.test.tsx`

**Interfaces:**
- Consumes: `usePutMemberGrant`, `useDeleteMemberGrant`, `useMembers` (to pick people), `MemberGrant.source`.

- [ ] **Step 1: Write the failing tests**

```ts
it("frozen: no control adds or edits a group", ...);            // a tier change never widens access
it("frozen: members from the last sync are listed and marked frozen", ...);
it("manual: add a person with a role PUTs a member grant", ...);
it("guests can be given viewer only", ...);                     // role select for a guest offers Viewer alone
it("frozen banner never says sync will resume on its own", ...); // assert banner text lacks "will resume"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: FAIL on the frozen cases.

- [ ] **Step 3: Implement per D6.**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- space-access`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(settings): manual members for Team and frozen sync`

### Task 12: Transfer a departed person's personal artifacts

**Blocked on D7.**

**Files:**
- Create: `apps/dashboard/src/settings/Transfer.tsx`
- Modify: `apps/dashboard/src/settings/Members.tsx` (status and entry point, per D7)
- Test: `apps/dashboard/test/transfer.test.tsx`

**Interfaces:**
- Consumes: `useTransfer`, `useMembers`, `useSpaces`, `Member.status`, `Member.pendingTransfer`.
- Produces: `<TransferDialog member={Member} onClose={() => void} />`.

- [ ] **Step 1: Write the failing tests**

```ts
it("suspended or removed members with pendingTransfer > 0 offer Transfer", ...);
it("active members never offer Transfer", ...);
it("dialog shows the count, never titles", ...);                 // "12 personal artifacts"
it("transfer never requests the person's artifacts", ...);       // no request to R.artifacts with owner= or their space
it("successor list excludes the departed and guests", ...);
it("space target lists shared spaces only", ...);
it("success toasts the moved count and clears the badge after refetch", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- transfer`
Expected: FAIL.

- [ ] **Step 3: Implement per D7.** Confirm before sending; the button reads the count.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- transfer members`
Expected: PASS, `members.test.tsx` unchanged.

- [ ] **Step 5: Commit** `feat(settings): transfer a departed person's artifacts`

### Task 13: Hosted sign-in page (Google and emailed codes)

**Blocked on D8.**

**Files:**
- Modify: `apps/dashboard/src/pages/SignIn.tsx`, `apps/dashboard/src/router.tsx:153-155` (pass `error` value, not just presence)
- Create: `apps/dashboard/src/pages/EmailCode.tsx`
- Test: `apps/dashboard/test/signin-hosted.test.tsx`, `apps/dashboard/e2e/signin-hosted.spec.ts`

**Interfaces:**
- Consumes: `useAuthProviders`, `startEmailCode`, `verifyEmailCode`, `AUTH.google`.
- Produces: `SignIn({ error?: string })` (`"1"` today's failure, `"domain"` wrong Google domain); `normalizeCode(raw: string): string | null` in `EmailCode.tsx` (strips spaces and dashes; six digits or null).

- [ ] **Step 1: Write the failing tests**

```ts
it("access mode renders today's page unchanged", ...);          // "Continue with Cloudflare Access", no Google button
it("direct mode renders Continue with Google linking AUTH.google", ...);
it("brand footer does not say Self-hosted on Cloudflare in direct mode", ...);
it("error=domain explains to use the company Google account", ...);
it("same screen for unknown address", ...);                     // 204 for any email → code step, identical copy
it("code normalizes spaces and dashes", () => {
  expect(normalizeCode(" 123-456 ")).toBe("123456");
  expect(normalizeCode("12345")).toBeNull();
});
it("invalid_code keeps the email and clears the code", ...);
it("rate_limited shows the wait from Retry-After and disables Resend", ...);
it("verify success redirects to the return path", ...);         // via auth/redirect.tsx
it("no copy contains an em dash", ...);                         // scan rendered text for "\u2014"
// e2e/signin-hosted.spec.ts (mock, hosted): layout at 375 and 1280, light and dark; existing signin-split.spec.ts untouched
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test -- signin-hosted`
Expected: FAIL.

- [ ] **Step 3: Implement per D8.** Code input uses `inputMode="numeric"` and `autoComplete="one-time-code"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @oa/dashboard test -- signin-hosted && pnpm --filter @oa/dashboard test:e2e -- signin`
Expected: PASS, both `signin-split` and `signin-hosted`.

- [ ] **Step 5: Commit** `feat(sign-in): hosted Google and emailed-code sign-in`

### Task 14: Real end-to-end suite against a hosted-mode server

**Blocked on Backend P2 and P3 merged, and Tasks 3 to 13.**

**Files:**
- Create: `apps/dashboard/e2e/real/spaces.spec.ts`
- Modify: `apps/dashboard/e2e/real/fixtures.ts` (fixtures `spaceViewer`, `spaceEditor`, `admin` signed in through the dev login with hosted config)
- Test: the spec itself

**Interfaces:**
- Consumes: real server endpoints; Task 1 shapes as reconciled with Backend.

- [ ] **Step 1: Write the failing tests**

```ts
test("a space viewer sees no edit controls and the API refuses a publish", ...); // UI check plus direct POST → 403
test("an admin's space list and library never show another person's personal artifacts", ...);
test("an editor publishes into a space and moves it to another", ...);
test("public links off: Share can't make it public and /a/<id>/full embeds show NotPublic", ...);
test("transfer moves a removed person's artifacts to a successor", ...);
test("emailed code signs an invited guest in as read-only", ...);  // code read from the dev mailbox hook
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @oa/dashboard test:e2e:real -- spaces`
Expected: FAIL until the server and UI pieces are in place.

- [ ] **Step 3: Fix any contract drift** in Task 1 shapes (one commit per drift, with the Backend PR linked).

- [ ] **Step 4: Run tests to verify they pass, twice with parallel workers**

Run: `pnpm --filter @oa/dashboard test:e2e:real -- spaces --repeat-each=2`
Expected: PASS.

- [ ] **Step 5: Commit** `test(e2e): hosted spaces journey on a real server`

---

## Self-review

- **Spec coverage:** 4.1 sign-in → Task 13 (Google domain lock is server-side; UI shows `error=domain`); emailed codes for guests and trial → 13, 14. 4.2 spaces and personal space → 4, 5; roles → 1, 10, 11; "All members" → 10; Google-style ownership: space artifacts movable by managers → 3 (`can`), 7; personal not browsable by admins → 1 (mock), 5, 9, 12, 14; transfer → 12; per-artifact visibility kept → 8; public links off per space → 8, 9; contractors read-only → 3, 11 (guests viewer only), 14. 4.3 step 3 (connect IdP, map groups) → 10 (connect itself is control plane, M2). 4.5 Team manual members, frozen sync, never widens access → 11. Outside sharing and audit log are M4, out of P4.
- **Step scan:** every blocked task names its D-item; logic tests are fixed regardless of the pick.
- **Type consistency:** `artifactCan`, `canPublishTo`, `useHosted`, `useCurrentSpace`, `SpacePicker`, `useMoveArtifact`, `useTransfer`, `normalizeCode` used with the same signatures across tasks.
- **Review Focus:** five lines, each pinned to a named test in its owning task.
- **Proportion:** signatures, test names and assertions only; no component bodies.
