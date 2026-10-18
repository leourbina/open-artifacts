# Open Artifacts Implementation Plan — Overview

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an open-source, self-hosted artifact platform. Any MCP agent publishes HTML, Markdown, code, or PDF to the user's own Cloudflare Workers deployment, where artifacts are versioned, shared, viewed safely, and can hold live data.

**Architecture:**
- One Worker (`apps/server`) serves two hostnames:
  - **App host:** Hono API, MCP, OIDC login, and the dashboard SPA as static assets.
  - **Content host:** raw artifact files in an opaque-origin sandbox.
- **Storage:** metadata in D1, file bytes in R2 behind per-version manifests, OAuth state in KV, and a SQLite Durable Object per artifact for live-page data.
- **Rendering** happens in the browser, inside the sandbox, so every request fits the Workers Free plan's 10 ms CPU budget.

**Tech stack:**

| Area | Choice |
|---|---|
| Language and tooling | TypeScript 5.x, pnpm workspaces, Biome (lint and format), Vitest + `@cloudflare/vitest-pool-workers`, Playwright |
| Server | Hono, `@hono/zod-openapi`, Zod 4, Drizzle ORM (D1), `jose` |
| MCP | `agents` (`createMcpHandler` from `agents/mcp/server`), `@modelcontextprotocol/server` v2, `@cloudflare/workers-oauth-provider` |
| Dashboard | React 19, Vite, TanStack Router and TanStack Query, Radix primitives |
| Rendering | markdown-it, Shiki, Mermaid, pdf.js, jsdiff |
| Landing | Astro |
| Setup CLI | Node 20+ with tsx, execa, prompts |

**Spec:** `docs/superpowers/specs/2026-10-18-open-artifacts-design.md` (revision 2). Executors read the spec and this plan together. Section references like "spec §6.4" point into the spec.

## Plan files

| File | Track | Owner session |
|---|---|---|
| `00-overview.md` | Shared rules, contracts, milestones, review focus | all |
| `01-foundation.md` | F1–F4: repo, `packages/shared` contract, test harness, CI/CD | **OpenArtifacts Backend** for F1–F3 (runs first). F4 belongs to **OpenArtifacts Platform**. |
| `02-backend.md` | B1–B17: server, render, runtime, MCP, setup | **OpenArtifacts Backend**, except B16 (setup CLI) and B4's staging step, which belong to **OpenArtifacts Platform** |
| `03-design.md` | D1–D7: direction, `packages/ui`, screens, themes, brand, landing | **OpenArtifacts Design** |
| `04-frontend.md` | FE1–FE12: dashboard, shell, bridge, settings, end-to-end tests | **OpenArtifacts Frontend** |
| `05-integration.md` | I1–I4: cross-track end-to-end, adversarial security pass, live deploy, release | I1 and I2 belong to **OpenArtifacts QA & Security**; Backend holds them until that session exists. I3 and I4 belong to **OpenArtifacts Platform**. |

## How each lead executes (required)

Every lead runs its track using **superpowers:subagent-driven-development**. Each task goes through this loop:

1. **Implementer subagent.** It gets the task text, the Global Constraints, the Interfaces it consumes, and the spec sections the task cites. It works TDD: failing test, then minimal code, then passing test, then commit.
2. **Spec-compliance reviewer**, a fresh subagent. It checks the diff against the task and the spec, and lists anything missing or extra.
3. **Adversarial reviewer**, a fresh subagent with this brief: *"Your job is to break this. Find inputs, sequences, or environments where it fails, leaks data, exceeds 10 ms of CPU, or contradicts the spec. Write the failing test for each finding."* Every finding becomes a failing test before it gets a fix. If a finding is rejected, the reason is recorded in the task's commit message.
4. **Fix loop** until both reviewers pass.
5. **Ship it** following *Delivery* below: one PR per task, CI green, squash-merge, auto-deploy to staging, and a staging smoke check. Only then does the lead tick the task box.
6. Before any task is marked done, the lead runs superpowers:verification-before-completion: run the commands and paste the output. Never just claim it passes.

**At each milestone** (see below):
- The lead dispatches one **whole-track adversarial review** on the most capable model, and runs the milestone's end-to-end check.
- The lead reports to the other leads in **three lines or fewer**: what shipped, what contract changed, and what's blocked.

**Coordinating with other leads** happens over SendMessage, using the session names `OpenArtifacts Backend`, `OpenArtifacts Frontend`, `OpenArtifacts Design`, `OpenArtifacts Platform`, and (once it exists) `OpenArtifacts QA & Security`. Keep messages terse.

**Changing a contract:**
- Covers any change to `packages/shared`, the postMessage protocol, `packages/ui` exports, or the REST routes.
- The owner messages both other leads before merging. The message says what changed, why, and how to migrate.
- Nobody edits another track's package. They ask its owner instead.

## Delivery: small increments, always deployed (user decision)

- **Remote:** `https://github.com/leourbina/open-artifacts` (public). The default branch is `main`, which is protected by F4: it requires a PR and passing checks, and admins are held to the same rules.
- **One task is one PR.** A task bigger than about 400 changed lines (excluding generated files and lockfiles) is split into stacked PRs, `…-1`, `…-2`, each green on its own.
- **Branch names:** `<track>/<task-id>-<slug>`. Examples: `be/b06-publish`, `fe/fe04-bridge`, `de/d02-tokens`, `fo/f02-contract`, `in/i01-journey`.
- **PR title** is a Conventional Commit, for example `feat(server): race-safe publish (B6)`. release-please reads the squash-merge title, so it has to be right.
  - Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`, `build`.
  - Scopes: `shared`, `server`, `render`, `runtime`, `dashboard`, `ui`, `landing`, `setup`, `e2e`.
- **PR body:**
  - task id and a link to the plan file anchor
  - pasted test output
  - a summary of the adversarial review: findings, the test for each, and how it was fixed or why it was rejected
  - light and dark screenshots for UI changes
  - the attribution footer from the system reminder
- **Merging:**
  - The lead runs `gh pr merge --squash --delete-branch` once all three hold: CI is green, both reviewers have passed, and the branch is rebased on `main`.
  - There's no waiting for the user, because they asked for continuous delivery.
- **After merge to `main`,** `deploy-staging.yml` runs `wrangler d1 migrations apply --remote` and then `wrangler deploy --env staging`. Staging is:

  | Host | Serves |
  |---|---|
  | `staging.open-artifacts.com` | App |
  | `staging-content.open-artifacts.com` | Content |

  Then a smoke job hits `/healthz`, plus every milestone's smoke checks as they land. **If staging is red, every lead stops merging** until the lead who broke it fixes forward or reverts. **Platform watches staging:** it triages each red run, pings the lead who broke it, and owns the pipeline itself. Reverts go through a PR too.
- **The landing site** (`apps/landing`) gets a Workers preview URL on every PR, posted as a PR comment by CI. It deploys to `open-artifacts.com` only when a release is published.
- **Releases** use release-please (`googleapis/release-please-action`, manifest mode, a single root component, `release-type: node`, starting at `0.1.0`). It keeps a release PR open on `main`. **The Platform lead merges the release PR** at each milestone (M1, M2, M3) once staging is green (user decision: no human approval needed). Merging it publishes a GitHub release and tag, deploys the landing site, and sets the version `llms.txt` installs.
- **Database migrations** must stay compatible with the code that was running before them, because staging deploys every merge. Columns are added, never renamed or dropped within a release.

## Working copies

All three leads work in the same repository, so each one needs its own git worktree:

| Lead | Worktree |
|---|---|
| Backend | `/Users/leonardourbina/code/projects/openartifacts` (the main checkout) |
| Platform | `/Users/leonardourbina/code/projects/openartifacts-pl` |
| QA & Security | `/Users/leonardourbina/code/projects/openartifacts-qa` |
| Frontend | `/Users/leonardourbina/code/projects/openartifacts-fe` |
| Design | `/Users/leonardourbina/code/projects/openartifacts-de` |

- Frontend and Design create theirs with `git worktree add` once F1 is on `origin/main`, following superpowers:using-git-worktrees.
- An implementer subagent that runs in parallel gets its own worktree too.
- Each lead runs its own visual-companion server, using `--project-dir` set to its own worktree, and gives the user the full URL.

## Human gates

Stop and ask the user, through the lead session, at these points only:
- **F4:** the one-time Cloudflare API token and account id go into GitHub secrets. The user runs the `gh secret set` command, so the token never enters a transcript.
- **D1 and D6:** picking the design direction and the logo.

## Global Constraints

Every task's requirements include this section implicitly.

**Workers Free plan budgets:**
- Every Worker request path must stay under **10 ms of CPU** and **50 external subrequests**.
- No request path may parse or base64-decode more than **2 MB** inline. Larger data streams to R2.
- `tests/cpu-budget/` in `apps/server` asserts this for publish, read, content serving, and runtime calls (task B17).

**Security:**
- Artifacts are untrusted. They run only in `<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads">` from the content host. `allow-same-origin` and `allow-top-navigation` are never set.
- Every content-host response sends `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads` and never sets a cookie.
- **No access returns `404 not_found`.** The API never returns 403 for an artifact the caller can't see.
- Mutating `/api/v1` calls that use a session cookie require the header `X-OA-Request: 1`, and return `403 csrf` without it. Cookie: `oa_session`, with `HttpOnly; Secure; SameSite=Lax; Path=/`, max age 7 days.
- `X-Robots-Tag: noindex, nofollow` is on every response from both hosts, and `/robots.txt` is `User-agent: *\nDisallow: /` on both.

**Values pinned by the spec:**

| Thing | Value |
|---|---|
| ID format | 16-char base58, from `newId()` in `packages/shared` |
| Personal access token | `oa_pat_` followed by 32 base58 chars; only the SHA-256 hash is stored |
| Visibility | `private` (default) \| `team` \| `public` |
| Roles | `owner` \| `admin` \| `member` \| `guest` |
| Share roles | `viewer` \| `editor` |
| Formats | `html` \| `markdown` \| `code` \| `pdf` |
| Upload limits | 25 MB per file, 100 MB per publish, 2 MB inline per JSON/MCP publish |
| Live-page limits | 1 MB per doc, 50 MB per artifact database, 100 writes per minute per viewer, 30 writes per minute per anonymous IP |
| Soft delete | Recoverable for 30 days, then purged by the daily cron |
| Signed content URL lifetime | 10 minutes |
| Analytics cache | 5 minutes |

**Product rules:**
- MCP tool names and descriptions are vendor-neutral. The words "Claude", "Anthropic", and "OpenAI" never appear in tool names or descriptions.
- Deployed instances send no telemetry.
- The repo URL is defined in exactly one place: `packages/shared/src/meta.ts` exports `REPO_URL = "https://github.com/leourbina/open-artifacts"`.
- Node 20+. All packages are ESM. TypeScript runs with `"strict": true`.

**Process rules:**
- Commits within a branch are free-form. The squash-merge title is what counts (see *Delivery*). End each commit message with the attribution lines from the session's system reminder.
- Never use `--no-verify` or force-push to `main`. Never bypass branch protection.

## Review Focus

These are the five failure modes most likely to bite a real user that the spec implies but ordinary task tests wouldn't cover. Each one has a pinned test in the task that owns the code.

1. **A malicious artifact tries to escape.** It reads `parent.document`, sets `top.location`, calls `fetch('/api/v1/...')` on the app host with credentials, forges postMessage replies, or sends `db.set` naming another artifact. Expected: every attempt fails, and the shell ignores messages whose `event.source` isn't its own iframe. **Pinned in:** B10 (`content-host.sandbox.test.ts`), FE4 (`bridge.spec.ts`), and I2 (`escape.spec.ts`).
2. **Hostile file paths in a publish.** Examples: `../x`, `/etc/passwd`, `a\\b`, `./a/../../b`, an empty segment, a NUL byte, paths over 512 chars, a case-only duplicate of another path, and an `entry` that isn't in `files`. Expected: `400 bad_request` naming the path, with nothing written to R2. **Pinned in:** F2 (`paths.test.ts`) and B6 (`publish.paths.test.ts`).
3. **Access after access changes.** A share is revoked, a member is removed, the artifact is soft-deleted, or a guest tries to list or search. Expected: list, search, get, versions, data, and new signed content URLs all return 404 or leave the artifact out. A signed URL that was already issued keeps working until its 10-minute expiry, and the docs say so. **Pinned in:** B5 (`authz.matrix.test.ts`) and B8 (`search.authz.test.ts`).
4. **The free plan's daily quota runs out.** D1 returns its "exceeded D1's free tier daily" error. Expected: the API responds `503 quota_exceeded` with the message "Daily free-plan limit reached; resets at 00:00 UTC". MCP tools return the same text as an error result, and the dashboard shows a banner. **Pinned in:** B1 (`errors.test.ts`) and FE2 (`quota-banner.spec.ts`).
5. **Concurrent publishes to the same artifact.** Two agents publish at once. Expected: the versions are distinct and consecutive (n+1 and n+2), nothing is lost, and `current_version` is the highest. **Pinned in:** B6 (`publish.concurrency.test.ts`).

## Milestones and dependency graph

```
M0  F1 → F4 (CI/CD + staging live) → F2 → F3   (Backend; unblocks everyone)
        │
        ├── Design:   D1 (user picks direction) → D2 tokens → D3 components ─┬→ D4 screens → D5 themes → D6 brand → D7 landing
        │                                                                     │
        ├── Backend:  B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9 → B10 → B11 → B12 → B13 → B14 → B15 → B16 → B17
        │
        └── Frontend: FE1 (mocks from F2) → FE2 → FE3 … FE11 (uses D3 when ready; until then, unstyled primitives) → FE12
M1  "Publish & view":      B1–B11 + FE1–FE5 → I1 partial (agent publishes, owner views)
M2  "Share & live data":   B12–B16 + FE6–FE11 → I1 full + I2 adversarial
M3  "Ship":                B17, D7, FE12 → I3 staging becomes a real open instance → I4 milestone release (Platform lead merges the release-please PR)
```

Frontend never waits on Backend. It works against `packages/shared` schemas, using the MSW mocks from F3. Frontend never waits on Design either. It uses Radix primitives with `packages/ui` tokens, and adopts D3 components as they land.
