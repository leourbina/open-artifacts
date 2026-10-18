# Track D — Design (owner: OpenArtifacts Design)

Read `00-overview.md` first.

**Shipping:** every task ships through its own PR and the full *Delivery* flow in the overview: branch, PR, CI, squash-merge, staging deploy, staging smoke. Where a task says "Commit with `<msg>`", that `<msg>` is the PR title, with ` (<task id>)` appended. A task is done only once its change is live on staging.

**Brief (spec §9):** "a calm, document-first tool, not a flashy one". The content is the hero. The chrome stays quiet, typography carries the hierarchy, and color is used sparingly for state.

**Showing the user work:** anything shown to the user, such as directions, screens, and reviews, goes to them as **visually rich HTML in the brainstorming visual companion**. Never send them markdown. Start the companion with `--project-dir /Users/leonardourbina/code/projects/openartifacts` if it isn't already running.

**Visual verification:** every Design task that produces UI ends by using the `proofshot` skill to capture light and dark screenshots at 1280 px and 390 px wide, and attaching them to the commit message body as paths.

---

### Task D1: Visual direction (human decision)

**Files:**
- Create: `design/directions/*.html`, which are throwaway pages served through the visual companion.

**Interfaces:**
- Produces `design/DIRECTION.md`, which records:
  - the chosen direction name
  - the type pairing
  - the neutral ramp
  - one accent color
  - the corner radius scale
  - one paragraph of rationale

**Steps:**

- [ ] **Step 1: Build 3 distinct directions.**
  - Each direction is one full-page mockup of the **library** plus one of the **artifact view**. Use real-looking content: a Markdown plan, a poll HTML artifact, and a PDF.
  - Each must work in both light and dark.
  - Suggested range, which the designer may replace:
    - **Paper:** warm off-white, serif headings.
    - **Studio:** neutral gray, sans throughout, dense.
    - **Ink:** high contrast, monochrome with a single accent.
- [ ] **Step 2: Show the user.**
  - Push a side-by-side comparison screen to the visual companion, with clickable options.
  - Ask the user to pick one, or to mix elements from several.
  - **Wait for their answer.**
- [ ] **Step 3: Record the choice.**
  - Write `design/DIRECTION.md`.
  - Commit with `docs(design): visual direction`.

---

### Task D2: Design tokens (`@oa/ui/tokens`)

**Files:**
- Create: `packages/ui/src/tokens/tokens.css`, `packages/ui/src/tokens/index.ts`, `packages/ui/test/contrast.test.ts`

**Interfaces:**
- Produces **CSS custom properties** on `:root`, with dark values under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` and `:root[data-theme="dark"]`:

| Group | Properties |
|---|---|
| Color | `--oa-bg`, `--oa-surface`, `--oa-surface-2`, `--oa-border`, `--oa-text`, `--oa-text-muted`, `--oa-accent`, `--oa-accent-text`, `--oa-accent-soft`, `--oa-danger`, `--oa-warning`, `--oa-success`, `--oa-focus` |
| Type | `--oa-font-sans`, `--oa-font-serif`, `--oa-font-mono`, `--oa-text-xs` … `--oa-text-2xl` |
| Shape and space | `--oa-radius-sm`, `--oa-radius-md`, `--oa-radius-lg`, `--oa-space-1` … `--oa-space-8` (4 px base) |
| Elevation and motion | `--oa-shadow-1`, `--oa-shadow-2`, `--oa-duration-fast` (120 ms), `--oa-duration` (200 ms), `--oa-ease` |

- Produces the **TypeScript export** `export const tokens: Record<string, { light: string; dark: string }>`, which the contrast test uses.
- **Fonts** come only from Google Fonts or the system stack. The deployment makes no other third-party requests.

**Steps:**

- [ ] **Step 1: Write the failing contrast test.**
  - WCAG AA: `text` on `bg`, `text` on `surface`, and `accent-text` on `accent` are all ≥ 4.5:1 in both themes.
  - `text-muted` on `bg` is ≥ 4.5:1.
  - `border` on `bg` is ≥ 1.5:1.
- [ ] **Step 2: Implement the tokens from D1** and run the test until it passes.
- [ ] **Step 3: Commit.**
  - Commit with `feat(ui): design tokens`.
  - Message both leads: "D2 tokens live: import '@oa/ui/tokens.css'".

---

### Task D3: Core components (`@oa/ui`)

**Files:**
- Create: `packages/ui/src/components/*.tsx`, `packages/ui/src/components/*.module.css`, `packages/ui/src/index.ts`, `packages/ui/ladle/*.stories.tsx`
- Test: `packages/ui/test/components.test.tsx` (vitest + Testing Library + axe)

**Interfaces:**
- Produces the following exports. They're React 19, and Dialog, Menu, Tooltip, Tabs, Select, and Toast wrap Radix primitives.

```ts
Button({ variant?: "primary"|"secondary"|"ghost"|"danger"; size?: "sm"|"md"; loading?: boolean; icon?: ReactNode } & ButtonHTMLAttributes)
IconButton({ label: string; icon: ReactNode; … })          // label → aria-label + tooltip
Input, Textarea, Select<T>({ options: {value:T; label:string}[]; value; onChange }), Switch, Checkbox, SegmentedControl<T>
Dialog({ open; onOpenChange; title: string; description?: string; children; footer?: ReactNode })
Menu({ trigger: ReactNode; items: Array<{ label; onSelect; danger?: boolean; icon? } | "separator"> })
Tabs({ tabs: {id; label; content}[]; value?; onValueChange? })
Tooltip({ content; children }), Toast API: toast({ title; description?; tone?: "info"|"success"|"danger" })
Badge({ tone?: "neutral"|"accent"|"success"|"warning"|"danger"; children })
Avatar({ name?: string; email: string; size?: 24|32 })     // initials, deterministic hue from email
Card, EmptyState({ icon; title; description; action? }), Skeleton({ width?; height? }), Spinner
FormatIcon({ format: Format; size? })                       // distinct glyph per html|markdown|code|pdf
VisibilityBadge({ visibility: Visibility })                 // lock / users / globe
Kbd, Banner({ tone: "info"|"success"|"warning"|"danger"; title; children; action? }) // used for the quota banner
AppShell({ nav: ReactNode; header?: ReactNode; children }) // responsive: sidebar ≥ 960px, drawer below
NavItem({ href; icon?; label: ReactNode; count?: number; active?: boolean } & AnchorHTMLAttributes) // sidebar row; aria-current when active
```

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - Every component renders with zero axe violations.
  - `IconButton` requires `label`, which is checked by type and at runtime.
  - `Dialog` traps focus and closes on Escape.
  - `Menu` is fully keyboard-navigable.
  - `Avatar` gives the same email the same hue.
- [ ] **Step 2: Implement.**
  - Every Ladle story shows light and dark side by side.
- [ ] **Step 3: Show the user.**
  - Push a designed component-sheet page to the visual companion.
  - Collect any feedback, then iterate.
- [ ] **Step 4: Commit.**
  - Commit with `feat(ui): core components`.
  - Message Frontend: "D3 components live; adopt in place of Radix primitives".

---

### Task D4: Dashboard screen designs (handoff to Frontend)

**Files:**
- Create: `design/screens/*.html`, which are static HTML built with `@oa/ui` tokens, plus `design/screens/README.md` as an index.

**Interfaces:**
- Produces one high-fidelity HTML mockup per screen. Frontend matches these.
- Every screen comes in light and dark, at 1280 px and 390 px wide, with empty, loading, and error states.

| Screen | Contents |
|---|---|
| Library | Grid and list toggle; scope tabs (All · Mine · Shared with me · Team); filters for format, agent, and owner; search; the drop zone overlay |
| Artifact view | Viewer shell with the title bar (title, format, visibility badge, version picker, share button, overflow menu), a collapsible side panel with Versions, Share, and Details tabs, and the raw-open action |
| Version diff | Source diff, plus rendered previews side by side |
| Share dialog | Visibility segmented control, an email invite list with role select, and copy link |
| Settings | Members; Agents (MCP URL, per-agent snippets, OAuth clients, tokens with a create dialog that shows the token once); Instance |
| Usage | Four meters with limits, plus the "not configured" state with setup steps |
| Edge pages | No access, Sign in, 404, and the quota-exceeded banner |
| OAuth consent | Server-rendered by Backend from this design |
| Anonymous public viewer | Minimal chrome |

**Steps:**

- [ ] **Step 1: Build the screens.**
- [ ] **Step 2: Show the user.**
  - Push a navigable screen gallery to the visual companion.
  - Make the requested changes.
- [ ] **Step 3: Commit.**
  - Commit with `docs(design): dashboard screens`.
  - Message Frontend with the gallery path, and Backend with the consent screen path.

---

### Task D5: Render themes (handoff to Backend B11)

**Files:**
- Create: `packages/render/src/theme.css`, owned by Design, plus `packages/render/src/shiki-themes.ts` (`export const shikiThemes = { light: ThemeRegistration; dark: ThemeRegistration }`)

**Interfaces:**
- Produces Markdown typography: headings, lists, tables, blockquote, task lists, code, Mermaid container, and footnotes.
- Produces the code view: line numbers, copy button, and long-line wrapping toggle.
- Produces the pdf.js page chrome.
- Everything uses `--oa-*` tokens **inlined**. The content host can't load the dashboard CSS, so `theme.css` is fully self-contained.
- The reading width is ≤ 72ch, and the base font size is ≥ 16 px.

**Steps:**

- [ ] **Step 1: Build a fixture page.**
  - Create `packages/render/fixtures/kitchen-sink.md`, which exercises every element.
  - Render it with B11's `renderMarkdown`. Until B11 lands, use markdown-it directly.
- [ ] **Step 2: Show the user.**
  - Push light and dark renders to the visual companion and iterate.
- [ ] **Step 3: Commit.**
  - Commit with `feat(render): reading themes`.
  - Message Backend.

---

### Task D6: Brand assets

**Files:**
- Create: `packages/ui/src/brand/logo.svg`, `packages/ui/src/brand/mark.svg`, `apps/dashboard/public/favicon.svg`, `apps/landing/public/og.png` (1200×630), `apps/landing/public/favicon.svg`

**Interfaces:**
- Produces the logo (wordmark plus mark), which works on light, dark, and the accent color.
- Produces a favicon that reads clearly at 16 px.
- The mark must not resemble any existing company's logo.

**Steps:**

- [ ] **Step 1: Build 3 mark options.**
  - Push them to the visual companion.
  - The user picks one.
- [ ] **Step 2: Export the assets.**
- [ ] **Step 3: Commit.**
  - Commit with `feat(brand): logo and favicons`.

---

### Task D7: Landing site, docs, and llms.txt (`apps/landing`, open-artifacts.com)

**Files:**
- Create:
  - `apps/landing/astro.config.mjs`
  - `apps/landing/src/pages/index.astro`
  - `apps/landing/src/content/docs/*.md`, with the pages: `setup.md`, `connect-agents.md`, `mcp-tools.md`, `runtime-api.md`, `security.md`, `upgrade.md`, `self-hosting-costs.md`
  - `apps/landing/src/pages/llms.txt.ts`
  - `apps/landing/src/pages/llms-full.txt.ts`
  - `apps/landing/wrangler.jsonc` (static assets only, route `open-artifacts.com`)
- Test: `apps/landing/test/llms.test.ts`

**Interfaces:**
- Consumes: `REPO_URL` from `@oa/shared`; the MCP tool list, imported from `apps/server/src/mcp/tool-manifest.json`, which B14 emits at build; and the setup flags from B16.
- Produces **`/llms.txt`**. It's built from the docs collection, so it can't drift.
  - It starts with `# Open Artifacts` and a one-paragraph summary.
  - Then comes `## Set up Open Artifacts for your user`, a numbered agent procedure:
    1. Check prereqs.
    2. `git clone --depth 1 --branch $(latest tag) {REPO_URL}`.
    3. `pnpm install`.
    4. Ask the user to run `npx wrangler login` (`--device` on a remote machine).
    5. `pnpm oa:setup --json`, with each `action_required` relayed to the user verbatim.
    6. Write the MCP config using the printed snippet for *this* agent.
    7. Open the Welcome link for the user.
  - Then `## Update an existing install`, `## Connect another agent`, `## Tools`, and `## Docs` (links to each page as `.md`).
- Produces **`/llms-full.txt`**: every doc page concatenated.
- Produces the **landing page**:
  - A hero that says what it is in one sentence.
  - The single CTA: *"Tell your agent: set up open-artifacts.com/llms.txt"*, with a copy button.
  - A 3-step visual: tell the agent, log in to Cloudflare, share artifacts.
  - Screenshots from FE once they're available. Until then, the D4 mockups.
  - Feature cards: any agent, your Cloudflare, versions, sharing, live pages, free-plan friendly.
  - A security model summary and a GitHub link.
- **Lighthouse targets:** ≥ 95 for performance, accessibility, best practices, and SEO. The landing site *is* indexable. Only deployed instances are noindex.

**Steps:**

- [ ] **Step 1: Write the failing test.**
  - The `llms.txt` build output contains the exact headings above.
  - It contains every tool name from `tool-manifest.json`.
  - It contains `oa:setup --json`, and `REPO_URL` appears exactly where expected.
  - No link in `llms.txt` returns 404 in the built site.
- [ ] **Step 2: Implement.**
  - Show the landing page to the user in the visual companion.
  - Iterate.
- [ ] **Step 3: Verify.**
  - Run `pnpm --filter @oa/landing build && pnpm --filter @oa/landing test`, plus Lighthouse CI on `astro preview`.
  - Expected: PASS and scores ≥ 95.
- [ ] **Step 4: Commit.**
  - Commit with `feat(landing): site, docs, llms.txt`.
  - Every PR gets a landing preview URL from CI. The production deploy to open-artifacts.com happens automatically when release-please publishes a release (I4).
- [ ] **Step 5: Milestone.**
  - Run a whole-track adversarial review: is any doc claim false against the code? Run every llms.txt step against a fresh clone in a scratch dir, up to the human gate.
  - Report to the leads.
