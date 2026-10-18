# Track FE — Frontend (owner: OpenArtifacts Frontend)

Read `00-overview.md` and `01-foundation.md` first.

**Shipping:** every task ships through its own PR and the full *Delivery* flow in the overview: branch, PR, CI, squash-merge, staging deploy, staging smoke. Where a task says "Commit with `<msg>`", that `<msg>` is the PR title, with ` (<task id>)` appended. A task is done only once its change is live on staging.

**Where things live**
- Code: `apps/dashboard/src/`
- Unit and component tests: `apps/dashboard/test/` (Vitest, Testing Library, MSW using `createHandlers` from `@oa/shared/mocks`)
- End-to-end tests: `apps/dashboard/e2e/` (Playwright)

**Commands**
- Unit tests: `pnpm --filter @oa/dashboard vitest run <file>`
- End-to-end tests: `pnpm --filter @oa/dashboard playwright test <file>`

Every task also runs its tests until they pass, commits, and captures light and dark screenshots with `proofshot`.

**Design inputs**
- Until D3 lands, use Radix primitives styled with `@oa/ui/tokens.css`.
- Once D3 lands, switch to the `@oa/ui` components.
- Once D4 lands, match the screens in `design/screens/`.

**Talking to the user:** anything shown to the user goes as visually rich HTML in the visual companion.

**Module map**

```
src/
  main.tsx, router.tsx           # TanStack Router (file-less route tree), QueryClient
  api/client.ts                  # typed fetch wrapper over R.* (adds X-OA-Request, parses ApiError, throws ApiClientError)
  api/queries.ts                 # query keys + hooks per resource
  auth/useMe.ts                  # /me; 401 → anonymous mode
  layout/AppLayout.tsx           # AppShell nav, quota banner slot
  library/*                      # list, grid, filters, search, drop zone
  viewer/Shell.tsx               # title bar + iframe + side panel
  viewer/bridge.ts               # postMessage bridge (shell side)
  viewer/useContentUrl.ts        # signed URL with refresh before expiry
  viewer/panels/{Versions,Share,Details}.tsx
  viewer/Diff.tsx
  upload/*                       # drag-drop, upload pipeline
  settings/{Members,Agents,Instance,Usage}.tsx
  pages/{NoAccess,NotFound,SignIn}.tsx
```

---

### Task FE1: App scaffold, API client, routing

**Files**
- Create: `apps/dashboard/{index.html, vite.config.ts}`, `src/main.tsx`, `src/router.tsx`, `src/api/client.ts`, `src/api/queries.ts`
- Test: `test/client.test.ts`

**Interfaces**
- Consumes: `R`, `AUTH`, all schemas, `ApiErrorSchema`, `QUOTA_MESSAGE`, and `createHandlers` from F2/F3.
- Produces:

```ts
export class ApiClientError extends Error { code: ErrorCode; status: number; details?: unknown }
export const api: {
  get<T>(path: string, schema: z.ZodType<T>): Promise<T>;
  send<T>(method: "POST"|"PUT"|"PATCH"|"DELETE", path: string, body: unknown, schema?: z.ZodType<T>): Promise<T>; // JSON, adds X-OA-Request: 1, credentials: "same-origin"
  putRaw(url: string, body: Blob, contentType: string, onProgress?: (p: number) => void): Promise<void>;          // XHR for progress
};
export const qk: { me: ["me"]; artifacts: (q: ListQuery) => unknown[]; artifact: (id) => unknown[]; versions: (id) => unknown[]; shares: (id) => unknown[]; search: (q) => unknown[]; members: ["members"]; tokens: ["tokens"]; oauthClients: ["oauth-clients"]; settings: ["settings"]; usage: ["usage"] };
// hooks: useArtifacts(q), useArtifact(id), useVersions(id), usePublishVersion(id), usePatchArtifact(id), useDeleteArtifact(id), useShares(id), usePutShare(id), useDeleteShare(id), useSearch(q), useMembers(), useTokens(), useOAuthClients(), useSettings(), useUsage()
```

- Routes:

| Path | Page |
|---|---|
| `/` | Library, scope `all` |
| `/mine`, `/shared`, `/team` | Library, scoped |
| `/search?q=` | Search results |
| `/a/$id`, `/a/$id/v/$v` | Viewer |
| `/a/$id/diff/$from/$to` | Version diff |
| `/settings/members`, `/settings/agents`, `/settings/instance`, `/settings/usage` | Settings |
| `/no-access`, `*` | NotFound |

- Dev server: Vite on 5173 proxies `/api`, `/auth`, `/mcp`, `/oauth`, `/a/*` HTML and `/healthz` to `http://app.localhost:8787`. `VITE_MOCK=1` enables MSW in the browser instead.

**Steps**
- [ ] **Step 1: Write the failing tests** in `client.test.ts`:
  - `send` sets `X-OA-Request: 1`.
  - A 404 body throws `ApiClientError` with `code: "not_found"`.
  - A response that fails its schema throws `ApiClientError` with `code: "internal"` and a message naming the field.
  - A 503 quota response throws with `code: "quota_exceeded"` and `QUOTA_MESSAGE`.
- [ ] **Step 2: Implement.** `pnpm --filter @oa/dashboard build` outputs to `apps/dashboard/dist`, which the server's assets binding reads.

---

### Task FE2: Auth state, layout, edge pages, quota banner

**Files**
- Create: `src/auth/useMe.ts`, `src/layout/AppLayout.tsx`, `src/pages/*.tsx`, `src/layout/QuotaBanner.tsx`
- Tests: `test/layout.test.tsx`, `e2e/quota-banner.spec.ts`

**Interfaces**
- `useMe(): { status: "loading" } | { status: "anonymous" } | { status: "authed"; me: Me }`
  - A 401 means anonymous. Anonymous visitors to any route other than `/a/*` are sent to `AUTH.login?next=`.
- `QuotaBanner` shows `Banner tone="warning"` with `QUOTA_MESSAGE` whenever any query or mutation fails with `quota_exceeded`. It uses a global QueryCache `onError`.
- Navigation:
  - Library, Shared with me, Team (only if `me.user.role` isn't guest), Settings (members and above), avatar menu (email, Sign out → `POST AUTH.logout`).
  - Guests see only "Shared with me".

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - `layout.test.tsx`:
    - A guest sees no Team or Settings nav.
    - Anonymous at `/` redirects to login with `next=/`.
    - Anonymous at `/a/x` does **not** redirect.
  - `quota-banner.spec.ts` (Review Focus #4): with MSW `quotaExceeded: true`, the banner text equals `QUOTA_MESSAGE` on the library page.
- [ ] **Step 2: Implement.**

---

### Task FE3: Library — list, grid, scopes, filters, search

**Files**
- Create: `src/library/{Library.tsx, ArtifactCard.tsx, ArtifactRow.tsx, Filters.tsx, SearchBox.tsx, useLibraryQuery.ts}`
- Test: `test/library.test.tsx`

**Interfaces**
- URL search params are the state: `format`, `agent`, `view=grid|list` (also remembered in localStorage inside try/catch), and `q`.
- `useLibraryQuery()` → `useInfiniteQuery` over `R.artifacts` using `nextCursor`, with infinite scroll through IntersectionObserver.
- The card shows:
  - Thumbnail, or a fallback: a typographic card with `FormatIcon` and the title.
  - Title, `FormatIcon`, `VisibilityBadge`, `lastAgent.name`, owner avatar (only when it isn't you), and relative `updatedAt`.
- The search box debounces by 250 ms and navigates to `/search?q=`. Results show `snippet`, with `[`…`]` rendered as `<mark>` and HTML escaped first.
- Empty states:
  - Mine, empty: "Ask your agent to publish something", with a link to Settings → Agents.
  - Shared, empty, and search with no results each have their own text.

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - Fixtures render 1 card per artifact.
  - Changing the format filter updates the URL and the request query.
  - Scrolling loads the next page.
  - A snippet like `<img onerror>` renders as text.
  - The empty Mine state shows the agents link.
- [ ] **Step 2: Implement.**

---

### Task FE4: Viewer shell and postMessage bridge

**Files**
- Create: `src/viewer/{Shell.tsx, bridge.ts, useContentUrl.ts, TitleBar.tsx}`
- Tests: `test/bridge.test.ts`, `e2e/bridge.spec.ts`

**Interfaces**

```ts
// viewer/bridge.ts
export function createBridge(opts: {
  iframe: HTMLIFrameElement; artifact: ArtifactSummary; version: number;
  viewer: { email: string; name: string | null } | null; theme: "light" | "dark";
  onPdfText: (text: string) => void; onThumb: (blob: Blob) => void; onResize?: (h: number) => void;
}): { dispose(): void; requestThumbnail(): void; setTheme(t: "light"|"dark"): void };
```

- Accepts a message only if **all** of these hold:
  - `event.source === iframe.contentWindow`
  - `event.origin === "null"`
  - `parseArtifactMessage` succeeds
- On `hello`, it replies `welcome` with `artifact.capabilities` and the viewer. The viewer is only included if `capabilities.viewer` is set; otherwise it sends `null`.
- On `call`:
  - Check `METHOD_CAPABILITY`. An undeclared capability replies `capability_denied` without a network call.
  - Map the method to an `R.data*` or `R.storage*` request for **this shell's** artifact id. Any id in `params` is ignored, so an artifact can't target another one.
  - Reply with a `result`.
- `db.subscribe` opens one WebSocket to `R.dataSubscribe(id)` per collection with reference counting. It forwards `db.change` events, and reconnects with exponential backoff capped at 30 s.
- `useContentUrl(id, v)` fetches `R.contentUrl` and refetches 60 s before `expiresAt`. On refresh it changes the iframe `src` only if the iframe hasn't loaded yet; otherwise it keeps the loaded document.
- Iframe attributes, exactly: `sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"`, `referrerpolicy="no-referrer"`, `allow="clipboard-write"`, and `title={artifact.title}`.
- The title bar holds: title (editable inline for editors and above, through PATCH), `FormatIcon`, `VisibilityBadge`, the version picker (`/a/$id/v/$v`), the Share button (owner only), "Open raw" (opens the content URL in a new tab), and an overflow menu (Copy link, Download entry, Delete for the owner).
- Anonymous viewers of public artifacts see a minimal title bar and a "Sign in" link.

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - `bridge.test.ts` (Review Focus #1, shell side):
    - A message from `window` or another iframe is ignored, and no fetch happens.
    - `origin !== "null"` is ignored.
    - A `call` whose params contain `{ artifactId: "other" }` still hits this artifact's route.
    - An undeclared capability gets `capability_denied` with zero fetches.
    - `welcome.viewer` is `null` when `capabilities.viewer` is false.
  - `e2e/bridge.spec.ts`, against `wrangler dev` with dev-login:
    - An HTML artifact with `capabilities.db` sets and gets a doc through `window.openArtifacts`, and the value persists after reload.
    - The iframe has the exact sandbox attribute.
- [ ] **Step 2: Implement.**

---

### Task FE5: Versions panel and diff

**Files**
- Create: `src/viewer/panels/Versions.tsx`, `src/viewer/Diff.tsx`
- Test: `test/versions.test.tsx`

**Interfaces**
- The Versions tab shows a timeline, newest first. Each row has `v{n}`, the message (or "No message"), the agent name, the author avatar, and relative time.
- Row actions: View (`/a/$id/v/$v`), Compare with current (`/a/$id/diff/$v/$current`), and Restore (editor and above; confirm Dialog, then `R.restoreVersion`, then navigate to the new version).
- Diff:
  - Fetches both entries through `R.versionFile` and runs a jsdiff `diffLines` unified view with ±3 context lines and a "Show all" option.
  - For html and markdown, a second tab shows two sandboxed iframes side by side using `useContentUrl` for each version.
  - It also compares the file lists: added, removed, and changed paths by size.
  - Binary entries say "Binary file changed".

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - Restore calls the route and navigates to v(n+1).
  - The diff of fixture v1→v2 shows the exact added and removed lines.
  - A viewer doesn't see Restore.
- [ ] **Step 2: Implement.**

---

### Task FE6: Share dialog and details panel

**Files**
- Create: `src/viewer/panels/{Share.tsx, Details.tsx}`, `src/viewer/ShareDialog.tsx`
- Test: `test/share.test.tsx`

**Interfaces**
- The share dialog is for the owner only.
- Visibility uses a `SegmentedControl` (private, team, public). Going to public requires a confirmation: "Anyone with the link can view. It won't appear in search engines."
- Invite by email with a role select (viewer or editor). The list of shares can change role or remove.
- Copy link copies `appOrigin + viewerPath(id)`.
- The panel also holds the live-data settings: a capabilities checkbox for each of db, viewer, and storage, plus `allowAnonymousWrites`. That last option is only enabled when the artifact is public and db is on.
- The Details tab:
  - Lets editors edit the title and description.
  - Shows read-only info: format, entry, files with sizes, created, and owner.
  - Gives the owner Delete, which asks for confirmation, then soft-deletes. A toast offers Undo, which calls `R.restoreDeleted`.

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - The public confirmation is shown, and cancelling keeps the artifact private.
  - The email is validated, and an invalid one never calls the API.
  - Undo after delete calls undelete.
  - A non-owner sees no Share tab.
- [ ] **Step 2: Implement.**

---

### Task FE7: Upload (drag and drop)

**Files**
- Create: `src/upload/{DropZone.tsx, uploadPipeline.ts, UploadDialog.tsx}`
- Test: `test/upload.test.ts`

**Interfaces**

```ts
export async function uploadArtifact(input: { files: File[]; title: string; artifactId?: string; message?: string; entry?: string },
  onProgress: (p: { done: number; total: number }) => void): Promise<PublishResult>;
```

- Each file goes `POST R.uploads` (passing `artifactId` once the first call reserves one), then `api.putRaw` to the signed URL. After that, one `POST R.artifacts` (create, with the reserved id) or `POST R.versions(id)` with `files: { [path]: { uploadId } }`.
- Folder drops keep relative paths (`webkitRelativePath`) and strip the common top folder.
- Client-side checks before anything is sent: each file ≤ `LIMITS.fileBytes`, total ≤ `LIMITS.publishBytes`, and paths pass `normalizePath`. On failure it shows which file failed.
- Default entry: `index.html`, else `README.md`, else the only file, else ask with a select in the dialog.
- After a PDF upload, the viewer's `onPdfText` handles indexing (FE11).
- Dropping onto the artifact view uploads a new version; dropping onto the library creates a new artifact.

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - Three files → three upload creates, three PUTs, then one publish, in that order.
  - A 26 MB file is rejected before any request.
  - A `../x` path is rejected.
  - Progress reaches `{done: 3, total: 3}`.
- [ ] **Step 2: Implement.**

---

### Task FE8: Settings — Members

**Files**
- Create: `src/settings/Members.tsx`
- Test: `test/members.test.tsx`

**Interfaces**
- Shows a table of members (avatar, email, role select, last seen, Remove) and an invite dialog (email plus a role of admin or member).
- The owner's row is locked. Admins can't select owner.
- Remove asks for confirmation: "Their artifacts will be transferred to you (owner)."

**Steps**
- [ ] **Step 1: Write the failing tests.** The owner row has no Remove. Inviting calls POST with a lowercased email.
- [ ] **Step 2: Implement.**

---

### Task FE9: Settings — Agents (MCP, OAuth clients, tokens)

**Files**
- Create: `src/settings/Agents.tsx`, `src/settings/snippets.ts`
- Test: `test/agents.test.tsx`

**Interfaces**
- `snippets(mcpUrl: string, token?: string): Array<{ agent: string; language: "bash"|"json"|"toml"; code: string }>` covers Claude Code, Codex CLI, Cursor, OpenCode, and Generic. Two variants each: OAuth (URL only) and Token (a Bearer header).
- Each snippet is a code block with a copy button.
- OAuth clients list (client name, connected date, Revoke) uses `R.oauthClients`.
- Tokens list plus a "Create token" dialog. The token is shown once, with a copy button and a warning: "You won't see this again."

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - Every snippet contains `mcpUrl`.
  - Token variants contain `Authorization: Bearer`.
  - The created token disappears from the DOM after the dialog closes.
  - Revoke calls DELETE.
- [ ] **Step 2: Implement.**

---

### Task FE10: Settings — Instance and Usage

**Files**
- Create: `src/settings/{Instance.tsx, Usage.tsx}`
- Test: `test/usage.test.tsx`

**Interfaces**
- Instance: name and default visibility (private or team), saved with PATCH `R.settings`.
- Usage, for owner and admin only:
  - Calls `GET R.usage`. When `available: false`, it shows the setup steps for `ANALYTICS_TOKEN` (`pnpm oa:setup` prompt, or `wrangler secret put ANALYTICS_TOKEN`).
  - Otherwise it shows a meter for each metric with `used / limit`. The meter turns `warning` at ≥ 80% and `danger` at ≥ 95%, and there's a "Resets at 00:00 UTC" note.

**Steps**
- [ ] **Step 1: Write the failing tests.** The not-available state shows the instructions. 85% renders the warning tone.
- [ ] **Step 2: Implement.**

---

### Task FE11: Thumbnails and PDF text pipeline (shell side)

**Files**
- Create: `src/viewer/useArtifactSideEffects.ts`
- Test: `test/sideeffects.test.ts`

**Interfaces**
- After the iframe sends `hello`, and only if `artifact.thumbnailUrl === null` and the viewer is an editor or above:
  1. Call `bridge.requestThumbnail()`.
  2. On `onThumb(blob)`, `PUT R.thumbnail(id)` if `blob.size ≤ LIMITS.thumbnailBytes`.
  3. Then invalidate `qk.artifact(id)`.
- When `format === "pdf"`, the version's `textIndexed` is false, and it's the current version: on `onPdfText`, call `PUT R.versionText(id, v)` once per session per version.

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - No thumbnail request when `thumbnailUrl` is set.
  - An oversized blob is dropped.
  - PDF text is sent only once.
  - A viewer (not an editor) doesn't request a thumbnail.
- [ ] **Step 2: Implement.**

---

### Task FE12: Dashboard end-to-end suite and track milestone

**Files**
- Create: `apps/dashboard/playwright.config.ts`, `e2e/fixtures.ts`, and `e2e/{library,viewer,share,upload,settings,anonymous}.spec.ts`

**Interfaces**
- `fixtures.ts` starts `wrangler dev` for `@oa/server` with the `ENVIRONMENT=dev` test config. It applies migrations to a fresh local D1 with `--persist-to` a temporary directory.
- It provides `loginAs(page, email, role)` through `AUTH.devLogin`, and `publishViaApi(pat, input)`.
- The app runs at `http://app.localhost:8787`.

**Steps**
- [ ] **Step 1: Write the specs.**
  - library: publish 3 through the API; they appear; filter and search work.
  - viewer: markdown renders a heading; code shows line numbers; a PDF shows page 1; HTML runs a script.
  - share: the owner shares with `bob@x.com` as viewer; Bob logs in and sees it in Shared; it's revoked; Bob gets a 404 page.
  - upload: drop a folder with `index.html` and `style.css`; the style applies.
  - settings: create a token; it works with `/mcp tools/list`.
  - anonymous: a public artifact opens logged out; a private one sends you to login.
- [ ] **Step 2: Run them.**
  - Run: `pnpm --filter @oa/dashboard playwright test`
  - Expected: all pass, in Chromium and WebKit.
  - In the same PR, turn the CI `e2e` job from a no-op into this suite.
- [ ] **Step 3: Milestones.**
  - After FE5 (M1) and after FE12 (M2), dispatch a whole-track adversarial review: XSS through titles, descriptions, snippets, and filenames; stale signed URLs; accessibility with axe on every route; a 390 px layout; and keyboard-only use.
  - Report to the leads.
