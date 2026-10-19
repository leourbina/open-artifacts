# Track F — Foundation (owner: OpenArtifacts Backend; runs first)

**Run order: F1 → F4 → F2 → F3.** CI/CD and staging come before any feature code, so every later PR deploys from the start.

Read `00-overview.md` first. Its Global Constraints apply to every task.

This track creates the repo and the **contract** (`packages/shared`) that all three tracks build against. Once F2 merges, its exports change only through the contract-change process in the overview.

---

### Task F1: Monorepo scaffold

**Files:**
- Create:
  - repo root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.nvmrc`, `LICENSE`, `README.md`
  - `apps/server/package.json`, `apps/dashboard/package.json`, `apps/landing/package.json`
  - `packages/shared/package.json`, `packages/ui/package.json`, `packages/runtime/package.json`, `packages/render/package.json`
  - `scripts/setup/package.json`
- Test: `scripts/check-workspace.test.ts`

**Interfaces:**
- Produces:
  - **Workspace packages:** `@oa/server`, `@oa/dashboard`, `@oa/landing`, `@oa/shared`, `@oa/ui`, `@oa/runtime`, `@oa/render`, `@oa/setup`.
  - **Root scripts:** `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm dev`. `pnpm dev` runs the server and dashboard watchers together.
  - **`pnpm oa:setup`** runs `pnpm --filter @oa/setup start`.

- [ ] **Step 1: Initialize git and write the failing workspace check.**
  - Run `git init`.
  - Write `scripts/check-workspace.test.ts`, a Vitest test that runs in Node. It reads `pnpm-workspace.yaml` and asserts:
    - The workspace globs include `apps/*`, `packages/*`, and `scripts/*`.
    - Every package listed above exists, its `package.json` has `"type": "module"`, and its name matches.
    - `.gitignore` contains `.superpowers/`, `.openartifacts/`, `node_modules/`, `dist/`, `.wrangler/`, and `apps/server/wrangler.jsonc`.
- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `pnpm vitest run scripts/check-workspace.test.ts`
  - Expected: FAIL, because the files are missing.
- [ ] **Step 3: Create the scaffold.**
  - `tsconfig.base.json`: `strict`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `target: "ES2022"`, `verbatimModuleSyntax: true`.
  - `biome.json`: recommended rules, 2-space indent, double quotes.
  - `LICENSE`: MIT, © 2026 Open Artifacts contributors.
  - `README.md`: one paragraph, plus a link to the docs. Link the repo at `https://github.com/open-artifacts-ai/open-artifacts`.
  - `.nvmrc`: `22`.
- [ ] **Step 4: Run it and confirm it passes.**
  - Run: `pnpm install && pnpm vitest run scripts/check-workspace.test.ts`
  - Expected: PASS.
- [ ] **Step 5: Bootstrap commit, pushed straight to `main`.** This is the only direct push in the whole plan. The repo is empty and has no branch protection yet.
  - Run: `git add -A && git commit -m "chore: scaffold pnpm monorepo"`
  - Then: `git branch -M main && git remote add origin https://github.com/open-artifacts-ai/open-artifacts.git && git push -u origin main`
  - From F4 on, every change goes through a PR (see the overview, *Delivery*).

---

### Task F2: Contract package `@oa/shared`

**Files:**
- Create in `packages/shared/src/`:
  - `index.ts`, `meta.ts`, `ids.ts`, `paths.ts`, `formats.ts`
  - `schemas.ts`, `errors.ts`, `routes.ts`, `protocol.ts`, `limits.ts`
- Tests in `packages/shared/test/`:
  - `ids.test.ts`, `paths.test.ts`, `formats.test.ts`, `schemas.test.ts`, `protocol.test.ts`

**Interfaces:**
- Produces everything below. Every other task imports these names.

```ts
// meta.ts
export const REPO_URL = "https://github.com/open-artifacts-ai/open-artifacts";
export const PRODUCT_NAME = "Open Artifacts";
export const API_VERSION = "v1";

// limits.ts
export const LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  publishBytes: 100 * 1024 * 1024,
  inlineBytes: 2 * 1024 * 1024,
  docBytes: 1024 * 1024,
  artifactDataBytes: 50 * 1024 * 1024,
  viewerWritesPerMin: 100,
  anonWritesPerMinPerIp: 30,
  pathMaxChars: 512,
  filesPerVersion: 1000,
  searchBodyChars: 200_000,
  signedUrlTtlSec: 600,
  softDeleteDays: 30,
  uploadTtlHours: 24,
  thumbnailBytes: 200 * 1024,
  extractedTextBytes: 1024 * 1024,
} as const;

// ids.ts
export function newId(): string;                    // 16 chars of [1-9A-HJ-NP-Za-km-z], from crypto.getRandomValues
export function isId(s: string): boolean;
export function newPat(): string;                   // "oa_pat_" followed by 32 base58 chars
export function isPat(s: string): boolean;

// paths.ts
export type PathError = "empty" | "absolute" | "traversal" | "backslash" | "control_char" | "too_long" | "empty_segment";
export function normalizePath(p: string): { ok: true; path: string } | { ok: false; error: PathError };
export function findCaseCollision(paths: string[]): [string, string] | null;

// formats.ts
export const FORMATS = ["html", "markdown", "code", "pdf"] as const;
export type Format = (typeof FORMATS)[number];
export function inferFormat(entry: string): Format;  // .html/.htm → html; .md/.markdown/.mdx → markdown; .pdf → pdf; anything else → code
export function inferLanguage(path: string): string;  // a Shiki language id: ts, tsx, js, py, go, rs, json, yaml, sh, sql, css, html, … otherwise "text"
export function contentTypeFor(path: string): string; // the usual MIME table; falls back to "application/octet-stream"
export function isTextContentType(ct: string): boolean;
```

`schemas.ts` uses Zod 4. Every type is `z.infer` of a schema with the same name minus `Schema`.

```ts
VisibilitySchema = z.enum(["private","team","public"])
RoleSchema = z.enum(["owner","admin","member","guest"])
ShareRoleSchema = z.enum(["viewer","editor"])
AccessLevelSchema = z.enum(["owner","editor","viewer"])
FormatSchema = z.enum(FORMATS)
CapabilitiesSchema = z.object({ db: z.boolean().default(false), viewer: z.boolean().default(false), storage: z.boolean().default(false) })
UserRefSchema = z.object({ id: z.string(), email: z.string().email(), name: z.string().nullable() })
AgentRefSchema = z.object({ name: z.string(), version: z.string().nullable() })
FileEntrySchema = z.object({ path: z.string(), size: z.number().int(), contentType: z.string() })
InlineFileSchema = z.union([z.string(), z.object({ base64: z.string() }), z.object({ uploadId: z.string() })])
PublishInputSchema = z.object({
  id: z.string().optional(),               // present → new version of an existing artifact
  title: z.string().min(1).max(200).optional(),   // required when id is absent (refine)
  description: z.string().max(2000).optional(),
  format: FormatSchema.optional(),
  content: z.string().optional(),
  files: z.record(z.string(), InlineFileSchema).optional(),
  entry: z.string().optional(),            // defaults: "index.html" | "README.md" | the single file
  language: z.string().optional(),
  message: z.string().max(500).optional(),
  visibility: VisibilitySchema.optional(),
  capabilities: CapabilitiesSchema.partial().optional(),
  allowAnonymousWrites: z.boolean().optional(),
}) // refine: exactly one of content|files; title required if !id; content requires format or entry
PublishResultSchema = z.object({ id: z.string(), version: z.number().int(), url: z.string().url() })
ArtifactSummarySchema = z.object({
  id, title, description: z.string().nullable(), format: FormatSchema, visibility: VisibilitySchema,
  owner: UserRefSchema, currentVersion: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
  lastAgent: AgentRefSchema.nullable(), thumbnailUrl: z.string().nullable(), access: AccessLevelSchema,
  capabilities: CapabilitiesSchema, allowAnonymousWrites: z.boolean(),
})
VersionInfoSchema = z.object({ version, message: z.string().nullable(), agent: AgentRefSchema.nullable(), createdBy: UserRefSchema, createdAt, entry: z.string(), files: z.array(FileEntrySchema), language: z.string().nullable(), textIndexed: z.boolean() })
ListQuerySchema = z.object({ scope: z.enum(["mine","shared","team","all"]).default("all"), format: FormatSchema.optional(), agent: z.string().optional(), q: z.string().optional(), updatedSince: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25), includeDeleted: z.coerce.boolean().default(false) })
// also export: type Page<T> = { items: T[]; nextCursor: string | null }
PageSchema = <T>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() })
SearchHitSchema = ArtifactSummarySchema.extend({ snippet: z.string() })
ShareSchema = z.object({ email: z.string().email(), role: ShareRoleSchema, createdAt: z.string() })
ArtifactPatchSchema = z.object({ title, description, visibility, capabilities, allowAnonymousWrites }).partial()
MemberSchema = z.object({ id, email, name: z.string().nullable(), role: RoleSchema, lastSeenAt: z.string().nullable() })
MeSchema = z.object({ user: MemberSchema, instance: z.object({ name: z.string(), defaultVisibility: VisibilitySchema, appUrl: z.string(), mcpUrl: z.string() }) })
TokenSchema = z.object({ id, label: z.string(), createdAt, lastUsedAt: z.string().nullable() })
TokenCreatedSchema = TokenSchema.extend({ token: z.string() })   // returned once
OAuthClientSchema = z.object({ grantId: z.string(), clientName: z.string(), createdAt: z.string() })
SettingsSchema = z.object({ name: z.string().min(1).max(80), defaultVisibility: z.enum(["private","team"]) })
UploadCreateInputSchema = z.object({ artifactId: z.string().optional(), path: z.string(), size: z.number().int().positive(), contentType: z.string().optional() })
UploadCreatedSchema = z.object({ uploadId: z.string(), artifactId: z.string(), url: z.string().url(), expiresAt: z.string() })
ContentUrlSchema = z.object({ url: z.string().url(), expiresAt: z.string().nullable() })   // null for public
DataDocSchema = z.object({ id: z.string(), data: z.unknown(), updatedAt: z.string(), updatedBy: z.string().nullable() })
DataQuerySchema = z.object({ where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), orderBy: z.string().optional(), order: z.enum(["asc","desc"]).default("asc"), limit: z.number().int().min(1).max(500).default(100), cursor: z.string().optional() })
UsageSchema = z.object({ available: z.boolean(), date: z.string(), metrics: z.array(z.object({ key: z.enum(["requests","d1_reads","d1_writes","do_requests"]), used: z.number(), limit: z.number() })) })
```

```ts
// errors.ts
export const ERROR_CODES = ["bad_request","unauthorized","csrf","not_found","conflict","too_large","rate_limited","quota_exceeded","capability_denied","internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const ApiErrorSchema = z.object({ error: z.object({ code: z.enum(ERROR_CODES), message: z.string(), details: z.unknown().optional() }) });
export const STATUS_FOR: Record<ErrorCode, number> = { bad_request:400, unauthorized:401, csrf:403, not_found:404, conflict:409, too_large:413, rate_limited:429, quota_exceeded:503, capability_denied:403, internal:500 };
export const QUOTA_MESSAGE = "Daily free-plan limit reached; resets at 00:00 UTC";
```

```ts
// routes.ts: the single source of truth for REST paths (server, dashboard, and mocks all import it)
export const R = {
  me: "/api/v1/me",
  artifacts: "/api/v1/artifacts",                       // GET list, POST create (JSON PublishInput)
  artifact: (id) => `/api/v1/artifacts/${id}`,          // GET summary, PATCH ArtifactPatch, DELETE soft-delete
  restoreDeleted: (id) => `/api/v1/artifacts/${id}/undelete`,      // POST
  versions: (id) => `/api/v1/artifacts/${id}/versions`,            // GET VersionInfo[], POST PublishInput (new version)
  versionFile: (id, v, path) => `/api/v1/artifacts/${id}/versions/${v}/files/${path}`, // GET raw (auth), for diff
  restoreVersion: (id, v) => `/api/v1/artifacts/${id}/versions/${v}/restore`, // POST → PublishResult
  versionText: (id, v) => `/api/v1/artifacts/${id}/versions/${v}/text`,  // PUT text/plain (PDF extraction)
  thumbnail: (id) => `/api/v1/artifacts/${id}/thumbnail`,          // PUT image/webp
  contentUrl: (id, v?) => `/api/v1/artifacts/${id}/content-url${v ? `?v=${v}` : ""}`, // GET ContentUrl
  shares: (id) => `/api/v1/artifacts/${id}/shares`,                // GET Share[], PUT {email, role}
  share: (id, email) => `/api/v1/artifacts/${id}/shares/${encodeURIComponent(email)}`, // DELETE
  uploads: "/api/v1/uploads",                                       // POST UploadCreateInput
  upload: (uploadId) => `/api/v1/uploads/${uploadId}`,              // PUT raw body (signed: ?sig=…&exp=…)
  search: "/api/v1/search",                                         // GET ?q=&cursor=&limit= → Page<SearchHit>
  members: "/api/v1/members", member: (id) => `/api/v1/members/${id}`,
  tokens: "/api/v1/tokens", token: (id) => `/api/v1/tokens/${id}`,
  oauthClients: "/api/v1/oauth-clients", oauthClient: (grantId) => `/api/v1/oauth-clients/${grantId}`,
  settings: "/api/v1/settings", usage: "/api/v1/usage",
  dataCollection: (id, col) => `/api/v1/artifacts/${id}/data/${col}`,          // GET list, POST /query
  dataQuery: (id, col) => `/api/v1/artifacts/${id}/data/${col}/query`,          // POST DataQuery
  dataDoc: (id, col, doc) => `/api/v1/artifacts/${id}/data/${col}/${doc}`,      // GET, PUT set, PATCH update, DELETE
  dataSubscribe: (id) => `/api/v1/artifacts/${id}/data-subscribe`,             // GET Upgrade: websocket
  storage: (id) => `/api/v1/artifacts/${id}/storage`,                          // GET list keys
  storageKey: (id, key) => `/api/v1/artifacts/${id}/storage/${key}`,           // GET, PUT, DELETE
} as const;
export const AUTH = { login: "/auth/login", callback: "/auth/callback", logout: "/auth/logout", devLogin: "/auth/dev-login" } as const;
export const MCP_PATH = "/mcp";
export const viewerPath = (id: string, v?: number) => v ? `/a/${id}/v/${v}` : `/a/${id}`;
```

```ts
// protocol.ts: postMessage between the artifact (iframe, opaque origin) and the shell (app host)
export const PROTOCOL_VERSION = 1;
export type RuntimeMethod =
  | "db.get" | "db.list" | "db.query" | "db.set" | "db.update" | "db.delete" | "db.subscribe" | "db.unsubscribe"
  | "viewer.get" | "storage.get" | "storage.set" | "storage.delete" | "storage.list";
export type ArtifactToShell =
  | { oa: 1; type: "hello"; protocol: number; kind: "html" | "markdown" | "code" | "pdf" }
  | { oa: 1; type: "call"; id: string; method: RuntimeMethod; params: unknown }
  | { oa: 1; type: "pdf.text"; version: number; text: string }
  | { oa: 1; type: "thumb.ready"; dataUrl: string }               // "data:image/webp;base64,…", decoded ≤ LIMITS.thumbnailBytes
  | { oa: 1; type: "resize"; height: number };
export type ShellToArtifact =
  | { oa: 1; type: "welcome"; capabilities: Capabilities; viewer: { email: string; name: string | null } | null; theme: "light" | "dark" }
  | { oa: 1; type: "result"; id: string; ok: true; value: unknown }
  | { oa: 1; type: "result"; id: string; ok: false; error: { code: ErrorCode; message: string } }
  | { oa: 1; type: "event"; event: "db.change"; collection: string; docs: DataDoc[]; deleted: string[] }
  | { oa: 1; type: "thumb.request" }
  | { oa: 1; type: "theme"; theme: "light" | "dark" };
export function sendToShell(msg: ArtifactToShell): void;   // window.parent.postMessage(msg, "*"); no-op when window.parent === window. Shared so @oa/render and @oa/runtime both use it.
export function parseArtifactMessage(data: unknown): ArtifactToShell | null;   // strict Zod parse; null on anything else
export function parseShellMessage(data: unknown): ShellToArtifact | null;
export const METHOD_CAPABILITY: Record<RuntimeMethod, keyof Capabilities> = { "db.get":"db", …, "viewer.get":"viewer", "storage.get":"storage", … };
```

- [ ] **Step 1: Write the failing tests.**
  - `ids.test.ts`:
    - `newId()` matches `/^[1-9A-HJ-NP-Za-km-z]{16}$/`.
    - 10,000 calls produce no duplicates.
    - `isPat(newPat())` is true. `isPat("oa_pat_short")` is false.
  - `paths.test.ts`, the **Review Focus #2** table. Each row asserts the exact `PathError`:
    - `""` → `empty`
    - `"/etc/passwd"` → `absolute`
    - `"../x"`, `"a/../../b"` → `traversal`
    - `"a\\b"` → `backslash`
    - `"a//b"` → `empty_segment`
    - `"a\u0000b"` → `control_char`
    - `"x".repeat(513)` → `too_long`
    - `"./a/b.css"` → `{ ok: true, path: "a/b.css" }`
    - `"a/./b"` → `"a/b"`
    - `findCaseCollision(["A.css","a.css"])` returns the pair.
  - `formats.test.ts`:
    - `inferFormat("index.HTML")` → `html`, `"notes.md"` → `markdown`, `"x.pdf"` → `pdf`, `"main.rs"` → `code`
    - `inferLanguage("a.tsx")` → `"tsx"`, `inferLanguage("Makefile")` → `"makefile"`, `inferLanguage("x.unknown")` → `"text"`
  - `schemas.test.ts`. `PublishInputSchema` rejects:
    - both `content` and `files`
    - neither of them
    - no `title` when there's no `id`
    - `content` with neither `format` nor `entry`

    It accepts `{ title: "t", format: "markdown", content: "# hi" }` and `{ id, files: { "index.html": "<p>" } }`.
  - `protocol.test.ts`. `parseArtifactMessage` returns `null` for:
    - `{ oa: 2, … }`
    - an unknown `type`
    - a `call` with an unknown method
    - extra top-level keys
    - a `thumb.ready` whose dataUrl isn't `data:image/webp;base64,`

    It returns the typed message for a valid `call`. `METHOD_CAPABILITY` has a key for every `RuntimeMethod`, which is checked against the full list.
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `pnpm --filter @oa/shared vitest run`
  - Expected: FAIL, because the modules are missing.
- [ ] **Step 3: Implement the modules with the signatures above.**
  - Build with `tsc -b` to `dist/`. Exports map: `"."` → `dist/index.js`.
  - Keep the package free of Node-only APIs. It runs in Workers, browsers, and Node 22.
- [ ] **Step 4: Run them and confirm they pass.**
  - Run: `pnpm --filter @oa/shared vitest run && pnpm --filter @oa/shared build`
  - Expected: PASS and a clean build.
- [ ] **Step 5: Ship it.**
  - Open a PR from `fo/f02-contract` titled `feat(shared): API contract, ids, paths, protocol (F2)`.
  - Follow the full *Delivery* flow in the overview.
- [ ] **Step 6: Contract announcement.**
  - Message `OpenArtifacts Frontend` and `OpenArtifacts Design`: "F2 merged: @oa/shared contract is live (schemas, routes R, protocol). Frontend may start FE1."

---

### Task F3: Test harness and API mocks

**Files:**
- Create:
  - `packages/shared/src/mocks/fixtures.ts`
  - `packages/shared/src/mocks/handlers.ts`
  - `apps/server/vitest.config.ts`
  - `apps/server/test/setup.ts`
  - `apps/server/wrangler.test.jsonc`
- Test: `packages/shared/test/mocks.test.ts`

**Interfaces:**
- Consumes: everything from F2.
- Produces:
  - `export const fixtures: { me: Me; artifacts: ArtifactSummary[]; versions: Record<string, VersionInfo[]>; members: Member[] }`. It covers at least one artifact per format, one public artifact, one shared-with-me artifact, and one artifact with `capabilities.db`.
  - `export function createHandlers(opts?: { latencyMs?: number; quotaExceeded?: boolean }): HttpHandler[]` (MSW v2). It covers every `R.*` route, validates request bodies against the F2 schemas, and returns the fixture data. With `quotaExceeded: true`, every route returns 503 `quota_exceeded`.
  - **Server test harness:** `@cloudflare/vitest-pool-workers` with D1, R2, KV, and the `ArtifactRuntime` DO bound, and migrations applied in `test/setup.ts` through `applyD1Migrations`.
  - `apps/server/test/helpers.ts`: `export async function login(email: string, role?: Role): Promise<{ cookie: string; userId: string }>`, which inserts the user and mints a session through the B4 session helper. Before B4 lands, it's a stub that throws "B4 pending".

- [ ] **Step 1: Write the failing test.**
  - In `mocks.test.ts`, start an MSW node server with `createHandlers()`.
  - `GET R.artifacts` returns a body that passes `PageSchema(ArtifactSummarySchema)`.
  - `POST R.artifacts` with `{}` returns 400 with an `ApiErrorSchema` body.
  - With `quotaExceeded: true`, `GET R.me` returns 503 and `error.message === QUOTA_MESSAGE`.
- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `pnpm --filter @oa/shared vitest run test/mocks.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement `fixtures.ts`, `handlers.ts`, and the server Vitest pool config.**
  - The mocks are exported from the subpath `@oa/shared/mocks`, so they never reach production bundles.
- [ ] **Step 4: Run it and confirm it passes.**
  - Run: `pnpm --filter @oa/shared vitest run && pnpm --filter @oa/server vitest run --passWithNoTests`
  - Expected: PASS.
- [ ] **Step 5: Ship it.**
  - Open a PR from `fo/f03-mocks` titled `test(shared): MSW contract mocks and workers test pool (F3)`.
- [ ] **Step 6: Milestone M0.**
  - Run the whole-track adversarial review: "Can any later task need a type or route that isn't in the contract? Do the mocks disagree with the schemas anywhere?"
  - Report M0 to both leads.

---

### Task F4 (owner: **OpenArtifacts Platform**, taking over PR #1 from Backend): CI/CD, branch protection, staging, release-please (runs second, right after F1)

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy-staging.yml`, `.github/workflows/landing-preview.yml`, `.github/workflows/release-please.yml`, `release-please-config.json`, `.release-please-manifest.json`, `docs/ops/staging.md`, `apps/server/wrangler.staging.jsonc`, and `apps/server/src/index.ts` (minimal `/healthz` only, so staging has something to serve).
- Test: `scripts/check-ci.test.ts`, which reads the workflow YAML and asserts the jobs and triggers below.

**Interfaces:**
- **`ci.yml`:**
  - Triggers: `pull_request`, plus `push` to `main`.
  - Jobs: `lint` (biome), `typecheck`, `test` (`pnpm -r test`), `build`, and `e2e`. `e2e` is a no-op until FE12, when it becomes Playwright.
  - Node 22 and pnpm, with the pnpm store cached.
  - These are the **required status checks** on `main`.
- **`deploy-staging.yml`:**
  - Trigger: `push` to `main`, with concurrency group `staging` and `cancel-in-progress: false`.
  - Steps: build → `wrangler d1 migrations apply open-artifacts-staging --remote --env staging` → `wrangler deploy --env staging` → `smoke`.
  - `smoke` sends `GET https://staging.open-artifacts.com/healthz`. It also runs `apps/server/test/smoke/*.ts` against staging, a directory that grows as milestones land.
  - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- **`landing-preview.yml`:**
  - Trigger: PRs touching `apps/landing/**`.
  - Runs `wrangler versions upload` for the landing Worker, then comments the preview URL on the PR.
- **`release-please.yml`:**
  - Trigger: `push` to `main`. Uses `googleapis/release-please-action@v4` with `config-file` and `manifest-file`.
  - On `release_created`, deploy `apps/landing` to production (`open-artifacts.com`).
- **`release-please-config.json`:**
  - `{ "packages": { ".": { "release-type": "node", "package-name": "open-artifacts", "changelog-path": "CHANGELOG.md", "bump-minor-pre-major": true } } }`
  - The manifest starts at `{ ".": "0.0.0" }`, so the first release is `0.1.0`.
- **`wrangler.staging.jsonc`, `env.staging`:**
  - Worker name `open-artifacts-staging`.
  - Custom domains `staging.open-artifacts.com` and `staging-content.open-artifacts.com`.
  - Its own D1 (`open-artifacts-staging`), R2 (`open-artifacts-staging`), and KV.
  - `ENVIRONMENT = "production"`. Staging is never dev mode, and dev-login stays off.
- **No Access gate on staging.** Staging is public from day one (user decision). It's protected only by the app's own auth, as that auth lands.
- **Branch protection on `main`**, set through `gh api -X PUT repos/open-artifacts-ai/open-artifacts/branches/main/protection`:
  - Required checks: `lint`, `typecheck`, `test`, `build`, `e2e`.
  - Branches must be up to date before merging.
  - `enforce_admins: true`.
  - No force pushes, no deletions.
  - Linear history (squash merges only, which is set in the repo settings).

**Steps:**
- [ ] **Step 1: Write the failing test.**
  - `check-ci.test.ts` asserts:
    - Each workflow exists with the triggers above.
    - `ci.yml` defines exactly the five required job ids.
    - `deploy-staging.yml` runs migrations before deploy, and smoke after.
    - `release-please-config.json` parses and has `release-type: node`.
- [ ] **Step 2: Implement the workflows and the configs.**
- [ ] **Step 3: HUMAN GATE.** Give the user a visual-companion page with:
  - A prefilled API token link. The token needs:
    - Account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers KV Storage Edit, Access: Apps and Policies Edit (for the OIDC app in B4), Account Analytics Read.
    - Zone `open-artifacts.com`: Workers Routes Edit, DNS Edit.
  - The commands for the user to run themselves, with `!`:
    - `! gh secret set CLOUDFLARE_API_TOKEN -R open-artifacts-ai/open-artifacts`
    - `! gh secret set CLOUDFLARE_ACCOUNT_ID -R open-artifacts-ai/open-artifacts`
  - A check that Zero Trust is enabled on the account, with a link if it isn't.
  - **Wait for the user to confirm.**
- [ ] **Step 4: Bootstrap staging once, following `docs/ops/staging.md`.**
  - Create the staging D1, R2, and KV with wrangler.
  - Record every resource id in `docs/ops/staging.md`. No secrets go in that file.
- [ ] **Step 5: Ship F4 through its own PR.**
  - PR `ci/f04-cicd`, titled `ci: CI, staging deploy, release-please (F4)`. This is the first PR. Its CI run proves CI works.
  - Merge it, then apply branch protection.
- [ ] **Step 6: Verify the whole pipeline.**
  - Run: `gh run watch` on the post-merge `deploy-staging` run.
  - Expected: success. `curl https://staging.open-artifacts.com/healthz` returns `{"ok":true}`.
  - release-please has opened (or updated) its release PR. Leave it open until M1.
