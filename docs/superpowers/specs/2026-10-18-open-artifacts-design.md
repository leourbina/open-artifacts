# Open Artifacts — Design

Date: 2026-10-18
Status: Draft for approval

## 1. Intent

Open Artifacts is an open-source, self-hosted place to keep, view, manage, and share the things AI coding agents make: HTML pages, Markdown docs, code, and PDFs. It's similar to [DocStash](https://docstash.ai/) and Claude Artifacts, with two differences:

- **Open to any agent.** It works with any MCP-capable agent, including Claude Code, Codex CLI, Cursor, OpenCode, and ChatGPT, not only one vendor's.
- **Owned by the user.** Each user deploys it to their own Cloudflare account and domain. Their artifacts never pass through a third party.

The project's public face is **open-artifacts.com**, a Cloudflare Worker owned by the project author. It hosts the landing page, the docs, and `open-artifacts.com/llms.txt`, which tells an agent how to install the platform. Setup follows the same pattern as `thingstodoapi.com/llms.txt`: the user tells their agent "set up Open Artifacts from open-artifacts.com/llms.txt", and the agent does the rest. The only manual step is the Cloudflare login.

## 2. Goals

1. Any MCP agent can publish, update, read, list, and search artifacts in the user's instance.
2. **Setup by an agent:** one `wrangler login`, then the agent deploys, configures auth, and registers the MCP server in its own client config.
3. **Formats:** HTML (interactive), Markdown, code (syntax highlighted), and PDF. An artifact can be several files, such as an HTML page with its CSS, JS, and images.
4. **Versions:** every publish creates an immutable version that records which agent made it and an optional change note. Old versions can be viewed and restored.
5. **Sharing:** artifacts are private by default. They can be shared with specific people as viewer or editor, or published as a public link. Public pages are `noindex`.
6. **Live pages:** an HTML artifact can save and read data through a small JS runtime API backed by a Durable Object per artifact. Polls, trackers, and checklists all work this way.
7. **Solo and team:** one deployment works for a single owner sharing with outside viewers, or for a small team publishing into the same instance.
8. **Sign-in:** Cloudflare Access is the identity layer. No passwords are stored.
9. **Web dashboard:** browse, search, view, manage versions, share, upload by drag and drop, and administer members and agent connections.
10. **Cost: friendly to the free plan** (user decision). Every feature works on the Workers Free plan, which allows 10 ms of compute per request and 100k requests per day. Heavy work runs in the browser, not the Worker. The docs recommend Workers Paid for heavy or public use. The dashboard shows today's free-plan usage and warns as it nears the limits.

## 3. Non-goals (v1)

- A hosted multi-tenant SaaS. Every instance belongs to one deployer.
- Comments and annotation threads. Planned for later; the data model shouldn't rule them out.
- Real-time co-editing of artifact source.
- Visitor analytics, custom social-preview images, and SSO beyond what Access offers.
- Running agent code on the server. Artifacts run only in the viewer's browser.
- A desktop or mobile app.

## 4. Anti-goals (failure even if it "works")

- **Unsafe artifact HTML.** Artifacts are untrusted, AI-written code. If one can read the viewer's session, call the API as the viewer outside the runtime API, or reach the dashboard's DOM, the product has failed.
- **Setup that needs a human at every step.** If a non-expert can't get from "read llms.txt" to a first publish with only the Cloudflare login, setup has failed.
- **Lock-in to one agent vendor.** Claude-only conventions must not leak into the MCP tools.
- **Accidental indexing.** A public link must never be indexed or listed anywhere.
- **Hard upgrades.** A deployer must be able to pull a new release and redeploy without losing data.

## 5. Decided by the user

- Self-hosted on Cloudflare Workers, on the deployer's own domain.
- Exposed as an MCP server. Setup is one-time and starts with a Cloudflare login.
- Landing site and `llms.txt` at open-artifacts.com, hosted as a Worker, following the thingstodoapi.com pattern.
- Cloudflare Access for sign-in.
- Live-page data is stored in Durable Objects.
- Supports both solo and team deployments.
- Development is led by three sessions, **OpenArtifacts Backend**, **OpenArtifacts Frontend**, and **OpenArtifacts Design**, and each uses subagent-driven development.

## 6. Architecture (designer's calls unless marked otherwise)

### 6.1 Repo layout (pnpm monorepo, TypeScript throughout)

```
apps/
  server/      # The deployable Worker: MCP, REST API, auth, dashboard assets, artifact content origin
  dashboard/   # React SPA, built into server's static assets
  landing/     # open-artifacts.com Worker: landing page, docs, llms.txt
packages/
  shared/      # Zod schemas + TS types shared by server/dashboard (API contract)
  runtime/     # window.openArtifacts client SDK injected into HTML artifacts
  ui/          # Design system: tokens, components (used by dashboard + landing)
scripts/
  setup/       # Idempotent setup/upgrade CLI that agents run (`pnpm oa:setup`)
docs/
```

License: MIT.

### 6.2 Cloudflare resources per deployment

| Resource | Purpose |
|---|---|
| Worker `open-artifacts` | MCP, API, dashboard, artifact serving |
| D1 `open-artifacts` | Metadata: users, artifacts, versions, shares, tokens, FTS search index |
| R2 `open-artifacts` | Artifact file bytes at `files/{artifactId}/{fileId}`. Each version stores a **manifest** that maps paths to file keys. Restoring a version only copies its manifest, and files that don't change are never re-uploaded. Thumbnails are stored at `thumbs/{artifactId}.webp`. |
| KV `OAUTH_KV` | OAuth grant/token state for the MCP OAuth provider |
| Durable Object `ArtifactRuntime` (SQLite) | One per artifact: live-page data and WebSocket fan-out |
| Access for SaaS (OIDC) app | Identity provider |

### 6.3 Hostnames

The deployer chooses a hostname on a zone they control, for example `artifacts.example.com`. A second host serves artifact content: `artifacts-content.example.com`, or a name the deployer picks.

- **App host:** dashboard, `/mcp`, `/api/*`, and the viewer shell `/a/{id}`.
- **Content host:** serves raw artifact files only, with no cookies. It's a separate origin from the app.

### 6.4 Artifact isolation (key security decision)

This mirrors how Claude Artifacts works.

- The viewer shell at `/a/{id}` on the app host loads the artifact in an `<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads">` from the content host. `allow-same-origin` is deliberately left out, so every artifact runs in an **opaque origin**. It can't read cookies, can't see the dashboard, and can't see other artifacts.
- The content host also sends `Content-Security-Policy: sandbox ...` with the same flags. That way, opening a content URL directly is just as isolated.
- Content URLs for private artifacts carry a short-lived signed token that the shell mints, because the content host has no session. Public artifacts need no token.
- The runtime API (§6.7) talks to the parent shell over `postMessage`. The shell checks each message and calls the API with the viewer's session. An artifact never holds credentials.
- The shell is also where the following live: the title bar, version picker, share button, and an "open raw" option. Raw view drops the chrome, keeps the sandbox, and has no runtime API.

### 6.5 Identity and authorization

- **Access as the identity provider, not as a gate.** Setup creates a Cloudflare Access for SaaS OIDC application. The Worker runs the OIDC login itself and issues its own HttpOnly session cookie. Access is not placed in front of the hostname. It can't be, because public links and per-artifact rules have to be decided by the Worker.
- **Access policy:** allow anyone to authenticate. Login methods are One-time PIN by default, with GitHub or Google optional. **Authorization happens in the app:** a person who signs in but isn't a member and has nothing shared with them sees "no access".
- **Roles:**
  - **Owner:** the first person to sign in after setup. Setup pins this to the deployer's email.
  - **Admin:** manages members and settings.
  - **Member:** publishes artifacts.
  - **Guest:** anyone with at least one artifact shared with them. Guests see only what's shared.
- **Artifact visibility:**
  - `private`: the creator plus anyone in its shares.
  - `team`: all members.
  - `public`: anyone with the link, no sign-in needed.
  - Shares give `viewer` or `editor` to an email address. The email doesn't need to have signed in yet.
- **Defaults:** a solo deployment is just one owner. A new artifact defaults to `private`. An admin can change the instance default to `team`.
- **Permissions** (designer's call, revision 2):
  - **Viewers** read.
  - **Editors** read, publish new versions, edit the title and description, and restore versions.
  - **Only the creator** can share, change visibility, or delete.
  - **Admins can't see** other people's private artifacts.
  - **Members get viewer access** to `team` artifacts.
  - **No access** returns `404`, never `403`, so the response doesn't reveal that the artifact exists.

### 6.6 MCP server

- **Remote MCP** over Streamable HTTP at `https://{app-host}/mcp`.
- **OAuth 2.1** through `@cloudflare/workers-oauth-provider`, with dynamic client registration. Cloudflare Access is the upstream login, so any OAuth-capable MCP client connects by URL alone.
- **Personal access tokens** are created in the dashboard (or by setup) and used as `Authorization: Bearer`. They're the fallback for agents and scripts without MCP OAuth support. Tokens are scoped to a user, can be revoked, and are stored hashed.
- **Agent attribution:** each version records the MCP `clientInfo.name/version` (or the token's label) and the user.
- Tools are vendor-neutral, with JSON-schema inputs and plain-text plus structured outputs:

| Tool | Purpose |
|---|---|
| `publish_artifact` | Create, or update with `id`, an artifact. Takes `title`, optional `description`, `format` (`html`/`markdown`/`code`/`pdf`, inferred if omitted), `content` (string) **or** `files` (path→content map; base64 for binary), optional `entry`, optional `language` for code, optional `message`, and optional `visibility`. Returns `id`, `version`, and the view URL. |
| `get_artifact` | Metadata plus the content of a version (latest by default). |
| `list_artifacts` | Filters: owner, format, visibility, agent, updated-since. Paginated. |
| `search_artifacts` | Full-text search over title, description, and extracted text. The server extracts text from HTML, Markdown, and code, which takes only a few ms. PDF text is extracted in the browser: by the dashboard when the PDF is uploaded, or the first time someone views it in the dashboard if an agent published it. Until then, a PDF can only be found by its title and description. |
| `list_versions` / `restore_version` | History, and restore. A restore creates a new version. |
| `share_artifact` / `unshare_artifact` / `set_visibility` | Sharing. |
| `delete_artifact` | Soft delete (recoverable for 30 days), then purge. |
| `artifact_data_get/list/query/set/update/delete` | Read and write an artifact's live-page data, the same store the runtime API uses. |

- **REST API:** `/api/v1/*` mirrors these operations for the dashboard and scripts. The schemas live in `packages/shared`, and an OpenAPI document is generated from them.

### 6.7 Live-page runtime API (`window.openArtifacts`)

- Injected into HTML artifacts by the shell, or included with a `<script>` from the content host. `packages/runtime` provides it as a typed SDK.
- **Capabilities are declared at publish time** in the artifact's metadata, for example `capabilities: { db: true, viewer: true }`. Undeclared calls are rejected.
- **API surface (v1):**
  - `db.collection(name)` with `get(id)`, `list()`, `query(filter)`, `set(id, doc)`, `update(id, patch)`, `delete(id)`, and `subscribe(cb)`. This is **shared** state that all viewers see, stored in the artifact's Durable Object in SQLite, with live updates over a WebSocket.
  - `viewer.get()` returns `{ email, name }` or `null` for anonymous viewers.
  - `storage` holds per-viewer documents keyed by the viewer's identity. It's for things like "my checklist ticks".
- **Write rules:** signed-in viewers with view access can read and write. Anonymous viewers of public artifacts can **read** shared data. They can write only if the publisher sets `allowAnonymousWrites`, and those writes are rate-limited per IP.
- **Limits** (configurable): 1 MB per document, 50 MB per artifact database, 100 writes per minute per viewer.
- **Versions and data:** data belongs to the artifact, not a version. A new version sees the same data.

### 6.8 Rendering by format

- **HTML:** served as-is in the sandbox. A multi-file artifact resolves relative paths against `artifacts/{id}/v{n}/`.
- **Markdown:** rendered **in the browser**, inside the sandbox, by a small renderer page on the content host. It produces themed HTML with GitHub Flavored Markdown, code highlighting, and Mermaid diagrams. HTML embedded in the Markdown is not passed through. Rendering in the browser keeps the Worker within the free plan's limits.
- **Code:** a syntax-highlighted view with a copy button, rendered in the browser. The language is inferred from the file extension or the `language` field.
- **PDF:** rendered by pdf.js inside the sandbox. Browser PDF plugins don't run in sandboxed iframes. The same pdf.js pass extracts the text for search and draws the first-page thumbnail. *(Designer's call, revision 2.)*
- **Metadata:** only public artifacts get their real OG title and description. These are added to the shell HTML on the server with HTMLRewriter. Private artifacts get a generic title, so a link never leaks what's behind it. Public pages send `X-Robots-Tag: noindex, nofollow` and `robots.txt` blocks everything on both hosts.

### 6.9 Dashboard (React SPA)

These are designer's calls, because the user approved the spec before the dashboard was discussed in detail:

- **Library:** a grid or list of artifacts with thumbnail, title, format, agent, owner, and last updated. Search box backed by FTS. Filters for mine, shared with me, team, format, and agent.
- **Artifact view:** the viewer shell from §6.4, plus a side panel with:
  - versions: timeline, view, a text diff between versions, restore
  - sharing: visibility, invite by email, copy link
  - details: editing title and description, delete
- **Upload:** drag and drop files to create an artifact or a new version.
- **Usage:** a panel showing today's free-plan usage (Worker requests, D1 and Durable Object reads and writes), with guidance on when to upgrade.
- **Settings:**
  - Members: invite, set role, remove.
  - Agent connections: the MCP URL with copy-paste config snippets for common agents, the list of OAuth clients with a revoke button, and personal access tokens.
  - Instance: name, default visibility, limits.
- **Thumbnails** (revision 5, user decision): generated **server-side with Cloudflare Browser Run**. After a publish or restore, a debounced background job screenshots the version's signed content URL (same sandbox, no cookies or capabilities, navigation pinned to the content host), at about 1280×800, as webp ≤ the thumbnail limit. It respects the free browser budget, stops for the UTC day once the budget runs out, and is skipped when the optional `BROWSER` binding is missing. The original browser-side snapshot (the runtime renders it on the shell's request) remains the fallback.
- **Usage panel:** needs an optional `ANALYTICS_TOKEN` secret with Account Analytics: Read. The Worker queries Cloudflare's GraphQL Analytics API and caches the result for 5 minutes. Without the token, the panel explains how to enable it.

### 6.10 Setup and upgrade flow

**open-artifacts.com/llms.txt** gives agent-facing instructions:

1. Check the prerequisites: Node 22+ (required by wrangler), git, a Cloudflare account, and a domain on Cloudflare. Explain each one to the user if it's missing.
2. Clone the repo, then run `pnpm install`.
3. Run `npx wrangler login`. **This is the one human step.**
4. Run `pnpm oa:setup`. It's interactive, and it also accepts flags so agents can run it without prompts. It is **idempotent and re-runnable**. It:
   1. Asks for the app hostname, the content hostname, and the owner email.
   2. Creates or reuses D1, R2, and KV, and writes `wrangler.jsonc`.
   3. Applies D1 migrations.
   4. Creates the Access for SaaS app and the policy, and stores the OIDC secrets as Worker secrets.
   5. Deploys the Worker with both custom domains.
   6. Runs a self-test: health check, an OIDC discovery check, and a test publish.
5. Register the MCP server in the agent's own config. llms.txt includes snippets for Claude Code, Codex CLI, Cursor, OpenCode, and generic clients. Designer's call: `oa:setup` mints a personal access token for the owner, and the agent writes it into its MCP config as a Bearer header. No OAuth or PIN sign-in is needed during setup. OAuth is for agents connected later and for the owner's first visit to the dashboard.
6. Publish a "Welcome" artifact and give the user the link.

**Access permissions:** the `wrangler login` OAuth token may not include Zero Trust/Access scopes. If it doesn't, setup prints a link to create a scoped API token (Access: Apps and Policies Edit, plus Zone/DNS as needed). The user pastes it once, and setup does not keep it. If the account has no Zero Trust organization yet, setup walks the user through enabling Zero Trust (free plan). The builder must verify what's actually needed and keep the manual steps as few as possible.

**Upgrade:** `git pull && pnpm oa:setup --upgrade` applies new migrations and redeploys. llms.txt has an "Update an existing install" section. Schema migrations must be forward-only and non-destructive.

### 6.11 Landing site (open-artifacts.com)

- A static Worker with Workers Static Assets, owned by the project author.
- Pages:
  - landing: what it is, a demo, and "tell your agent: set up open-artifacts.com/llms.txt"
  - docs: setup, MCP tools, runtime API, security model, upgrade
  - `/llms.txt`
  - `/llms-full.txt` (full docs for agents)
  - a link to the GitHub repo
- The llms.txt content is generated from the same docs source, so the two can't drift.

## 7. Constraints

- Cloudflare only: Workers, D1, R2, KV, Durable Objects, and Access.
- **Free-plan limits apply to every Worker code path:** 10 ms of CPU per request and 50 external subrequests. Backend tests include CPU-budget checks for publish, read, and runtime API calls.
- Each deployment has one Cloudflare account and one owner.
- **Upload limits:** 25 MB per file and 100 MB per publish.
  - Inline `content` and `files` in an MCP or JSON publish are capped at **256 KB total** (C3), because decoding and search indexing must fit the 10 ms CPU budget. Over it, publish returns 413 `too_large`: "Inline content is limited to 256 KB. Use create_upload for larger files, then publish with {uploadId}."
  - Anything larger goes through the `create_upload` tool or endpoint. It returns a signed PUT URL, and the body streams straight into R2.
  - Uploads that are never used are swept by a daily cron after 24 h.
- **Local development:** runs as `app.localhost:8787` and `content.localhost:8787`. A dev-only login, `/auth/dev-login`, is available when `ENVIRONMENT=dev` and returns `404` otherwise. Setup refuses to deploy with it turned on.
- No outbound telemetry from deployed instances.

## 8. Team split and execution (user decision, revision 2)

One master plan covers the whole system: `docs/superpowers/plans/2026-10-18-open-artifacts/`. The leads don't write their own plans. They execute their tracks of the master plan. Each lead:

- Runs every task through superpowers:subagent-driven-development: an implementer subagent, then a spec-compliance reviewer, then an **adversarial reviewer** whose job is to break the code, then fixes.
- Runs a whole-track adversarial review at each milestone.
- Is responsible for its track working **end to end**, proven by running it, not by assertion.

| Lead | Track |
|---|---|
| **OpenArtifacts Backend** | Foundation (repo, `packages/shared` contract), `apps/server`, `packages/render`, `packages/runtime` |
| **OpenArtifacts Platform** | CI/CD, staging (deploys, secrets, Access apps, watching staging), `scripts/setup`, releases (release-please), live verification |
| **OpenArtifacts QA & Security** (a cyberstrike agent, reached on the agent-bus) | An independent red team: the cross-track end-to-end journey, the sandbox-escape and security pass, attacks on each merge on staging, and the "stranger install" check before releases |
| **OpenArtifacts Frontend** | `apps/dashboard` (SPA, viewer shell, bridge, upload, settings, usage), local end-to-end suite |
| **OpenArtifacts Design** | Visual direction (the user picks from options), `packages/ui`, screen designs, render themes, brand assets, `apps/landing` with docs and llms.txt |

**Contracts:** Backend's Foundation track ships first and unblocks the other two. A change to `packages/shared` or the postMessage protocol is announced to the other leads before it merges.

## 9. Implementation choices (revision 2: designer's calls, from the §15 review)

- **Server:** Hono, plus Zod and `@hono/zod-openapi` for OpenAPI generation.
- **MCP:** `createMcpHandler` from `agents/mcp/server` (stateless), with `@modelcontextprotocol/server` v2. `McpAgent` is deprecated. OAuth is handled by `@cloudflare/workers-oauth-provider`.
- **D1:** Drizzle ORM. drizzle-kit generates the SQL migration files, and `wrangler d1 migrations` applies them.
- **Dashboard:** React, Vite, TanStack Router and TanStack Query, built as a pure SPA on static assets.
- **Rendering**, all in the browser inside the sandbox: markdown-it, Shiki, Mermaid (loaded only when a diagram appears), and pdf.js.
- **Diff:** jsdiff line diff of the source, plus rendered previews side by side for HTML and Markdown.
- **Rate limits:**
  - Per-viewer write counters live in the artifact's Durable Object.
  - Anonymous per-IP limits use the Workers rate-limit binding.
  - Defaults: 1 MB per doc, 50 MB per artifact, 100 writes per minute per viewer, 30 writes per minute per anonymous IP.
- **Releases:** llms.txt installs the **latest tagged release**, not `main`.
- **Repo URL:** `https://github.com/leourbina/open-artifacts` (user decision), defined once in `packages/shared/src/meta.ts`.

## 10. Delivery (user decision, revision 3)

- **Small PRs:** everything ships as small, single-task PRs to `github.com/leourbina/open-artifacts`. `main` is protected: a PR and passing CI are required, admins are held to the same rules, and merges are squash only, with Conventional Commit titles.
- **Staging:** every merge to `main` deploys to **staging**: `staging.open-artifacts.com` serves the app and `staging-content.open-artifacts.com` serves content (designer's call for the second host). Migrations run first, then a smoke test. A red staging deploy blocks all merges until it's fixed.
  - Staging has no Access gate. It's public from the start (user decision).
- **Releases** are managed by **release-please**: manifest mode, a single root component, starting at 0.1.0. The Platform lead merges the release PR at each milestone once staging is green. No human approval is needed (user decision). Publishing a release tags it, creates a GitHub release, and deploys the landing site to **open-artifacts.com**, which is on the user's Cloudflare account. Landing changes get preview URLs on their PRs.
- **Migrations** must stay compatible with the previous code, because staging deploys continuously.

## 11. Environments (user decision, revision 4)

| Environment | Hosts | How it's deployed |
|---|---|---|
| **Staging** (the test instance) | `staging.open-artifacts.com`, `staging-content.open-artifacts.com` | On every merge to `main` (§10). |
| **Production** (the user's personal instance) | `artifacts.leourbina.com`, `artifacts-content.leourbina.com` (the content host is a designer's call) | First install at the **first stable release**, by following `open-artifacts.com/llms.txt` / `pnpm oa:setup --name open-artifacts-prod` from that tag exactly as a stranger would. That doubles as the dogfood check. After that, `release-please.yml` upgrades it on every **stable** (non-pre-release) release with `oa:setup --upgrade`. It never deploys from `main`. |
| **Landing** | `open-artifacts.com` | On stable releases, behind the release gate. The user picks the design from **3 options** that Design presents. |
