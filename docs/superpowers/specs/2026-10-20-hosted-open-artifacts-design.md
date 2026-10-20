# Hosted Open Artifacts: design

Status: draft for review, 2026-10-20.

Provenance: **(user)** means the user decided it in the brainstorm. **(my call)** means the coordinator decided it and the user can override. Anything not tagged is context.

## 1. Intent

Open Artifacts can be self-hosted today: anyone can install it on their own Cloudflare account. Hosted Open Artifacts is a paid, turnkey version for small and medium companies. They sign up, pay, and get their own isolated install that we run, upgrade and bill for. **(user)**

The customer is a small or medium company that wants one central, company-owned store for the artifacts its AI agents produce. **(user)** (Roughly 20 to 500 people, using two or more AI tools, with no platform team that wants to run another service. **(my call)**)

### Why they pay (user)

1. **Access that follows the org structure (RBAC)**, with groups synced from the company's identity provider. Example: Engineering sees engineering artifacts, execs see everything, contractors get read-only.
2. **Controlled sharing outside the company**: read-only, expiring.
3. **It just works**: turnkey, lower operating cost than running it in-house.
4. **No provider lock-in**: artifacts are stuck today in Claude, ChatGPT and similar silos. Any agent can publish here over MCP.
5. **Real-time and more capable**: live pages with shared data that people and agents both edit.
6. **The company owns its artifacts**: they don't leave when an employee does.
7. **Mixed agent fleets**: one library across Claude Code, Cursor, ChatGPT and others.
8. Possibly: viewers need no paid AI seat.

Worth highlighting in marketing, but not a reason to buy because competitors have it: agents keeping artifacts up to date; durable links and version history. **(user)**

### Success (user)

Six months after launch: **10 paying companies, each actively using it every week.**

## 2. Goals, non-goals, anti-goals

### Goals

- Self-serve signup to a working install in minutes. **(user)**
- One isolated install per customer, in our Cloudflare account. **(user)**
- Sign-in through each customer's own identity provider, with groups synced from it. **(user)**
- RBAC over artifacts based on those groups. **(user)**
- Automatic upgrades inside a maintenance window each customer sets. **(user)**
- Import of existing artifacts on day one: each employee imports their own with their own agent, using the migration tool. **(user)**
- Billing: tiers; creators pay and viewers are free; artifacts come as a generous allowance, not a per-artifact fee; 14-day free trial, then paid. **(user)**

### Non-goals

- Installing into a customer's own Cloudflare account. Those customers self-host the open-source version. **(user)**
- A permanent free tier for the hosted version (only a 14-day trial). **(user)**
- An admin bulk import from company-wide exports in v1. **(my call)** It can follow later.
- Enterprise contracts, SLAs and data residency in v1. **(my call)** The Enterprise tier is listed as "contact us".

### Anti-goals (user)

**Data leaking between customers, or one customer being able to sign in to another customer's artifacts.** This is a failure even if everything else works, and every design choice is checked against it first.

## 3. Constraints

- **Same product, same code.** A hosted install runs the same open-source release as self-hosted installs. Hosted-only features (group sync, spaces and RBAC, outside-sharing controls, audit log) go into the open-source product behind configuration, unless the builder finds a strong reason to keep them out. **(my call)** This avoids a fork, and self-hosters benefit too.
- **Our Cloudflare account.** **(user)** All customers' installs sit in one Cloudflare account. A Cloudflare account per customer was rejected as too cumbersome.
- **No Cloudflare Access in hosted sign-in, and self-hosting can drop it too.** **(user)** The user first chose one shared Zero Trust organization. The cost model then showed that every Access sign-in, viewers and guests included, uses a Zero Trust seat: $7 per user per month past 50 users, shared across all customers in one organization. That turns every tier's margin negative and breaks "viewers free". Access also caps one organization at 50 identity providers. So hosted installs sign people in directly (section 4.1), and the same direct sign-in becomes a setup option for self-hosted installs, which keep Access as the default.
- **Isolation per customer** **(user)**: each install has its own Worker, D1 database, R2 bucket, KV namespace, Durable Objects, and secrets. **(my call)** No table or bucket shared across customers holds customer data. The control plane holds only account, billing and provisioning metadata.
- **Free-plan-style CPU budgets** still apply per request. The current product is tuned for them (CPU tests, D1 rows-written limits).
- **Copy rules:** no em dashes in user-facing copy; say "any AI agent".

## 4. What's decided about how

### 4.1 Architecture

- **A control plane** **(my call)** is a separate Worker app, owned by us, on our main domain. It handles signup, billing, provisioning, upgrades, maintenance windows and the customer admin console. It drives the existing `oa:setup` logic (resources, secrets, deploy, healthcheck, selftest), or a library extracted from it, through the Cloudflare API. It does not shell out to a laptop.
- **Each customer install** is a normal Open Artifacts deploy, at `<company>.<our hosted domain>` by default. A custom domain (`artifacts.company.com`) is a Business-tier feature. **(my call)**
- **Sign-in: direct, no Access** **(user)**. The server is already a generic OIDC client (PKCE), so it signs in straight against:
  - **Google Workspace and Microsoft Entra** through our own multi-tenant "Sign in with Google/Microsoft" apps. Each install accepts only its customer's verified domain (Google `hd`) or tenant id (Entra `tid`), checked on the server against the ID token, never the email alone. No per-customer connection or cost. **(my call)**
  - **Okta and generic SAML through WorkOS** **(my call, from the Clerk vs WorkOS evaluation)**. One central auth-broker Worker on the control plane holds the WorkOS API key; installs never do, because that key can read every customer's directory. The broker names the customer's organization on every sign-in. The callback requires an exact match on `organization_id`, `connection_id` and the verified email domain, then hands the install a short-lived signed assertion for that install only. IdP-initiated SAML is turned into a fresh SP-initiated flow. Group sync uses WorkOS Directory Sync's ordered Events API. Suspensions arrive as `state: inactive`, and a deleted directory sends one `dsync.deleted` with no per-user removals; both must revoke access. Buy WorkOS's custom auth domain early so a later exit doesn't force every customer to reconfigure.
  - **Emailed one-time codes, sent by us** through Cloudflare Email Sending, for invited guests and for the trial before the identity provider is connected. During the trial they're restricted to the company's verified email domain.
  - Why WorkOS over Clerk: WorkOS keeps no shared upstream session or user pool across customers, the customer is bound on every sign-in, setup links can be emailed to IT admins, and its events are ordered and replayable. Clerk was cheaper (about $125 vs $250 per customer per month for SSO plus SCIM) but weaker on tenant binding. Full report: `2026-10-20-hosted-research/okta-saml-provider-eval.md`.

### 4.2 RBAC (user: groups from the identity provider; my call: the model)

- **Spaces**: every artifact belongs to one space (for example "Engineering", "Exec", "Clients"). A personal space exists per user.
- **Roles per space**: viewer, editor (publish and edit), manager (share and manage the space). Identity-provider groups are mapped to roles on spaces by an admin in the admin console. "All members" is a built-in group.
- **Ownership follows Google Workspace** (user asked how Google Docs does it; my call that we copy it):
  - **Space artifacts belong to the company**, like files in a Google shared drive. When the creator leaves, the artifact stays in the space. Space managers can share, move or delete any artifact in their space.
  - **Personal artifacts belong to the person**, like My Drive. Admins and execs can't browse or read them, and "execs see everything" means every space, not personal spaces.
  - **When someone leaves** (they are removed or suspended in the identity provider), an admin transfers their personal artifacts to a successor or to a space, as with Google's ownership transfer. Until then, nobody new gets access.
  - Visibility stays per artifact (private to the space, all members, or public link). A space's role mapping decides who in the company counts as its members.
  - Public no-sign-in links still exist, but admins can turn them off per space. Outside sharing (below) is the controlled alternative.
- **Per-person sharing** still works on top, as today.
- **Contractors**: a group mapped to viewer only. Read-only is enforced on the server, including over MCP and the data API.
- **Outside sharing** (user: controlled; my call: the shape): links for people outside the company, read-only by default, with an expiry, revocable, and recorded in the audit log. Admins can turn outside sharing off per space.
- **People outside the identity provider** (contractors, clients) **(user: yes)** sign in with an emailed one-time code. This works only for addresses invited by email, and they never get more than read-only. This second login method gets particular attention in the security review and the cross-tenant suite, because it's the most likely way into another customer's install.
- **Audit log** (Business): views, publishes, shares, role changes and sign-ins, exportable.

### 4.3 Signup and lifecycle

1. An admin signs up on the website, picks a tier and starts the 14-day trial. **(user: self-serve; trial)** The payment provider is Stripe. **(my call)** Whether a card is required up front is left to the builder; the default is no card for the trial. **(my call)**
2. The control plane provisions the install. The target is under 2 minutes. **(my call)**
3. The admin is guided to connect their identity provider (Okta, Google Workspace, Microsoft Entra first), and to map groups to spaces.
4. The admin invites the team and copies MCP snippets for agents (from the existing agent-config step).
5. At day 14, without payment, the install becomes read-only for 30 days, then is deleted after notice. **(my call)** Export is always available.
6. **Cancellation**: the customer can export everything. After cancellation, data is deleted after 30 days. **(my call)**

### 4.4 Upgrades (user: automatic, in a customer-set window)

**(my call)** Releases roll out in waves: our own install, then a canary group, then everyone, each inside its own maintenance window. A failed healthcheck or selftest stops the rollout and rolls back that install, reusing `--rollback`. Urgent security fixes may skip the window, with notice. The control plane shows each install's version and upgrade history. Upgrades never pass `--allow-downgrade`.

### 4.5 Pricing (user: tiers, creators pay, viewers free, generous allowance, trial)

**(my call)** The draft tiers and prices are placeholders until each install's actual Cloudflare cost has been modelled:

| Tier | Price | Includes |
|---|---|---|
| Team | $10 per creator per month | Unlimited viewers and artifacts; company sign-in; spaces and roles with members managed by hand; live data, versions, sharing; pool of 10 GB plus 5 GB per creator |
| Business | $25 per creator per month | Team, plus groups synced from the identity provider (Google, Microsoft), outside-sharing controls, audit log, custom domain; pool of 25 GB plus 10 GB per creator |
| Okta / SAML add-on | about $250 per month per customer **(my call)** | Okta or SAML sign-in plus SCIM through WorkOS, which costs us about $250 per customer per month |

**The trial and tier changes** (user asked what happens after a trial with group sync; my call):

- The trial includes everything in Business.
- At the end, the customer picks a tier.
- Moving to Team turns sync off and **freezes** each space's membership as it was at the last sync. From then on it's managed by hand. Nothing is deleted and nobody gains access.
- Outside links keep working until they expire, but no new ones can be made.
- The audit log stays readable (exportable) for 90 days.
- Moving back up turns sync on again and replaces the frozen lists.
- The rule for every downgrade: **a tier change never widens access**.
| Enterprise | Contact us | Not built in v1 |

- A **creator** is anyone who published or edited in the billing period, whether through an agent or by hand. Viewing and commenting are free.
- **Artifact count is unlimited.** The allowance is only storage and live-data activity, pooled per company, sized so about 95% of customers never see an overage. Above it, there's metered billing, alerts at 80%, and a customer-set cap.

### 4.6 Import (user: day one, each employee via their own agent)

Each employee runs the existing migration tool (skill) in their own agent. The agent reads that person's Claude or ChatGPT export and publishes each artifact into the company install over MCP, into the right space, with the employee as owner. **(my call)** The import is idempotent, so re-running it doesn't duplicate artifacts, and it reports what was skipped. The skill still needs testing against a real claude.ai export.

### 4.7 Isolation and security (user: the anti-goal)

**(my call)**

- A cross-tenant test suite runs against two real installs on every release, and blocks the release if it fails. It checks that tenant A's identity can't sign in to B, and that A's tokens, PATs, OAuth clients, signed content URLs, WebSockets and data API calls all fail against B.
- Each install has its own secrets (SESSION_SECRET, CONTENT_SIGNING_KEY, its OIDC client credentials or broker assertion key). No key is shared across installs. The WorkOS key lives only in the auth broker.
- The control plane holds no customer artifact data. Its credentials are scoped to the minimum, and its actions are audited.
- An independent security review, including the direct sign-in, the WorkOS broker and the one-time-code path, takes place before the first paying customer.

### 4.8 Keep a later move to Workers for Platforms cheap (user: yes)

Start with the setup code reused as a library: one normal Worker per install, with a ceiling of about 490 customers on the 500-Worker account limit. Plan to move to Workers for Platforms before about 300 customers. These are requirements from the start:

1. **Export and import of a whole install**, including Durable Object data (live data and runtime docs). Durable Object storage belongs to the Worker that defines it, so the move to a dispatch namespace is an export and import. Cancellation and backups need this anyway.
2. **Provisioning behind one interface** (create, upgrade, roll back, delete, export, import an install), with today's per-Worker implementation first and room for a Workers for Platforms one.
3. **Every resource named by install ID** (Worker, D1, R2, KV, hostnames), never by hand, so routing can be generated.
4. **Verify Durable Objects support in Workers for Platforms** against current Cloudflare docs before the first paying customer, and record the result here.

## 5. Left to the builder

- How the control plane drives provisioning: the Cloudflare API directly, a library extracted from `oa:setup`, Workers for Platforms, or a mix. It must respect the per-customer isolation above.
- **Group sync uses both (user):** claims at sign-in for day one, plus push or polling sync so that removals and suspensions take effect right away. **Identity providers in order (user): Google Workspace first (FinQore uses it), then Microsoft Entra and Okta as a fast follow.** (my call) Google Workspace has no general-purpose SCIM push to custom apps, so for Google the "sync" half is likely an Admin SDK Directory API poll using a customer-granted read-only scope, with group membership read at sign-in. The builder confirms the exact mechanism. Entra and Okta support SCIM. How the RBAC schema is stored is left to the builder.
- Verify the Cloudflare limits that cap the customer count. Without Access, the binding limit is **500 Workers per account** (about 490 customers, see 4.8). KV allows 1,000 namespaces. Still to check: D1 databases and R2 buckets per account, and custom hostnames. D1's 10 GB per-database limit caps one install at roughly 100k+ artifacts.
- Real prices. A first cost model (`2026-10-20-hosted-research/hosted-cost-model.md`) puts Cloudflare usage at about $0.24, $1.27 and $14.89 per month for small (20 people), medium (100) and large (500) installs. That's an 86 to 96% gross margin at the draft prices once Access seats are gone. Stripe fees and fixed overhead dominate, then Durable Object rows written for heavy live data. Proposed meter: live-data writes, with Team at 250k plus 50k per creator per month and Business at double; overage at $10 per million writes and $0.10 per GB-month.
- Metering: how storage and live-data operations are counted per install and reported to billing.
- The admin console's UI (Design gives options and the user picks).
- The order of delivery: the builder proposes milestones. **The first milestone is the design partner, FinQore (user)**, on a hand-provisioned install with group-synced RBAC, before self-serve signup. FinQore uses Google Workspace, so Google goes first.
