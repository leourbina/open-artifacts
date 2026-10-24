# Viewer Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The viewer header shows who else has the artifact open right now (signed-in people by name, anonymous viewers as "Anonymous <Animal>", AI agents in their own shape), Google Drive style.

**Architecture:** Presence rides the existing `R.events` socket to the per-artifact `ArtifactRuntime` DO. The Worker route derives an opaque per-artifact presence key and display identity and hands them to the DO in upgrade headers; the DO keeps everything in socket attachments and three small SQLite tables (no in-memory state, so hibernation is safe), and broadcasts one coalesced `presence` frame on join, leave and agent expiry. Agents have no socket: MCP and REST calls that already reach the DO record them (one added fire-and-forget DO call per agent read), keyed by a new server-issued `Mcp-Session-Id`.

**Tech Stack:** Cloudflare Workers + Durable Objects (hibernating WebSockets, `setWebSocketAutoResponse`, alarms, SQLite), Hono, zod 4 (`@oa/shared`), MCP SDK v2 via `agents/mcp/server` (stateless), React 19 + TanStack + shadcn (`@oa/ui`), vitest (`@cloudflare/vitest-pool-workers` for the server), Playwright (mock and real configs).

**Spec:** `docs/superpowers/specs/2026-10-24-viewer-presence-design.md` (approved). Read it with this plan.

## Global Constraints

- Mirror Google Drive's patterns for every detail the spec leaves open.
- No email, no user id, no token id, no IP, no anonId in any presence frame or card. The token label goes only to the token's owner.
- Names only: a user with no name is "Member" (or "Guest" for role `guest`); initials and hue then come from the opaque per-artifact key. Never use `versionEvent`'s email fallback or `UserAvatar` (both use the email).
- Anonymous presence id: a random value in a session cookie `oa_pid` on the app origin (no `Expires`/`Max-Age`, `Path=/`, `SameSite=Lax`, `Secure` on https), never derived from or stored next to `oa.anonId`. The server treats it as opaque: `^[A-Za-z0-9_-]{16,64}$`, else ignored.
- The presence key shown to clients is per artifact (HMAC of artifact id + identity under a new `oa:presence` key), so it can't link a viewer across artifacts.
- Free plan: no polling; the client pings `"ping"` every 30 s and the DO answers `"pong"` through `setWebSocketAutoResponse` (no wake); stale sockets are found from `getWebSocketAutoResponseTimestamp` in the existing alarm; no per-socket timers; frames only on join, leave and agent expiry, coalesced.
- Timings (shared constants, `packages/shared/src/presence.ts`): `PRESENCE_PING_MS = 30_000`, `PRESENCE_STALE_MS = 75_000`, `PRESENCE_SWEEP_MS = 30_000`, `PRESENCE_GRACE_MS = 5_000`, `PRESENCE_COALESCE_MS = 1_000`, `AGENT_PRESENT_MS = 120_000`.
- Caps: display name 80 chars, activity 80 chars, roster at most `PRESENCE_LIST_MAX = 100` entries plus a `total`.
- No em dashes in user-facing copy; say "any AI agent" where relevant.
- Every change to an existing shared shape is optional and appended last (older clients parse; `json-shapes.snapshot.test.ts` stays byte-identical), and is recorded in `packages/shared/HOSTED_CONTRACT.md`.
- Design picks (spec Section 8; https://artifacts.leourbina.com/a/MkqMepcHeLvbGvKL): **1A** agents are a rounded square (7px radius at 28px, 10px at 40px) with the owner's initials and a color per session; people and anonymous viewers are circles. **2A** faces go first in the TitleBar right group, before the version chip, side by side with a 4px gap and no overlap; show 3 then "+N", or all 4 when exactly 4; phones show one face plus "+N". **3A** the agent card is plain lines: name, "<Owner>'s agent · Viewing|Editing", the note in quotes, captioned "In the agent's own words". **4A** white line-icon animals (Lucide style: 24px grid, 2px stroke, round caps) on one 9-color palette for both themes: Teal `#1f6f5a`, Violet `#5b48b8`, Rust `#b04a14`, Blue `#2456c4`, Berry `#a3305f`, Olive `#4d6b12`, Umber `#8a4d0f`, Sea `#0e6e8c`, Plum `#7a3f99` (white glyph at least 5.4:1). Faces are 28px with a 2px ring in the surface color; card faces 40px.
- Never `git stash`; commit WIP at checkpoints.

## Review Focus

1. **Old cached dashboards that never ping.** A tab running the previous SPA must not be swept as stale every 75 s (a reconnect loop). Only sockets that opened with `?ping=1` are swept; others leave on close only. Test in Task 3.
2. **DO hibernation between join and leave.** Roster, grace and agent rows must come back from attachments and SQLite alone after eviction. Test in Task 3 (fresh `ArtifactRuntime` instance on the same storage).
3. **Laptop sleep or network loss (no close frame).** The face is gone within `PRESENCE_STALE_MS + PRESENCE_SWEEP_MS` (105 s worst case). Test in Task 3 with the clock override.
4. **Hostile anonymous cookie.** Oversized, malformed or rotating `oa_pid` values can't break the roster or exhaust animals: malformed means a per-socket identity, and the existing 3-per-/56 anonymous socket cap bounds the faces. Test in Task 4.
5. **Hostile or odd names.** A 500-char name, HTML, RTL or emoji renders as plain text, capped at 80 chars; an anonymous viewer can never claim a name. Tests in Tasks 2 and 9.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/presence.ts` (new) | Presence schemas, frame, constants, animal list, palette size, cookie name, `AgentTouch` |
| `packages/shared/src/schemas.ts` | `ArtifactEventSchema` gains `presence`; `hello.you?`; `activity?` on get/data tool inputs |
| `packages/shared/src/mocks/events.ts` | `emitPresence` for dashboard tests and mock e2e |
| `packages/shared/HOSTED_CONTRACT.md` | New "Presence (both tiers)" section + CHANGED rows |
| `apps/server/src/runtime/roster.ts` (new) | Pure roster building: dedupe, order, animals, colors, agent names |
| `apps/server/src/runtime/do.ts` | Presence sockets, grace, sweep, coalesced broadcast, agent rows |
| `apps/server/src/runtime/routes.ts` | Events route: presence headers, cookie, `since`, `ping` |
| `apps/server/src/auth/keys.ts` | `oa:presence`, `oa:mcp-session` key labels |
| `apps/server/src/mcp/session.ts` (new) | Issue and verify `Mcp-Session-Id` |
| `apps/server/src/runtime/agent-presence.ts` (new) | Worker-side `agentTouch(...)` builder and fire-and-forget helper |
| `apps/server/src/mcp/server.ts`, `index.ts`, `mcp/oauth.ts`, `mcp/tools/*.ts`, `mcp/instructions.ts`, `routes/artifacts.ts`, `services/artifacts.ts` | Agent session and touches |
| `apps/dashboard/src/viewer/presenceId.ts` (new) | The `oa_pid` cookie |
| `apps/dashboard/src/viewer/liveEvents.ts` | Ping, `since`, `ping=1`, presence frames |
| `apps/dashboard/src/viewer/usePresence.ts` (new) | Roster state minus self |
| `apps/dashboard/src/viewer/presence/animals.tsx` (new) | `AnimalIcon`: Lucide icons plus the 45 drawn ones |
| `apps/dashboard/src/viewer/presence/*` (new) | `PresenceStack`, `PresenceAvatar`, `PresenceCard`, palette |
| `apps/dashboard/src/viewer/TitleBar.tsx`, `FullScreenEscape.tsx`, `Shell.tsx` | Placement |

---

### Task 1: Shared presence contract

**Files:**
- Create: `packages/shared/src/presence.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/schemas.ts:683-708` (`ArtifactEventSchema`), `:747-752` (`GetArtifactInputSchema`), `:794-830` (`ArtifactData*InputSchema`), `packages/shared/src/mocks/events.ts`, `packages/shared/HOSTED_CONTRACT.md`
- Test: `packages/shared/test/presence.test.ts` (new), `packages/shared/test/events.mock.test.ts`

**Interfaces:**
- Produces:
  - Constants listed in Global Constraints, plus `PRESENCE_COOKIE = "oa_pid"`, `PRESENCE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/`, `PRESENCE_PING = "ping"`, `PRESENCE_PONG = "pong"`, `PRESENCE_PALETTE_SIZE = 9`, `PRESENCE_NAME_MAX = 80`, `PRESENCE_ACTIVITY_MAX = 80`, `PRESENCE_LIST_MAX = 100`, `PRESENCE_KEY_RE = /^[A-Za-z0-9_-]{16}$/`.
  - `ANIMALS: readonly { id: AnimalId; name: string; lucide: boolean }[]`: 57 family-friendly animals, ids kebab-case, names Title Case: the 12 with a Lucide icon in `lucide-react` 1.59 (bird, cat, dog, fish, panda, rabbit, rat, snail, squirrel, turtle and the rest Lucide ships; `lucide: true`) plus 45 more to draw (include Duck, Capybara, Axolotl, Llama). `AnimalId` is the union of ids.
  - `PresenceEntrySchema = z.object({ key, kind: z.enum(["person","anon","agent"]), name: z.string().max(80), named: z.boolean(), color: z.number().int().min(0).max(8), animal: z.string().optional(), agent: z.object({ owner: z.string().max(80), product: z.string().max(80).optional(), label: z.string().max(80).optional(), state: z.enum(["viewing","editing"]), activity: z.string().max(80).optional() }).optional() })`. `named: false` means the name is a placeholder ("Member", "Guest", "Anonymous Duck", "Agent").
  - `PresenceFrameSchema = z.object({ type: z.literal("presence"), viewers: z.array(PresenceEntrySchema).max(100), total: z.number().int().min(0) })`, most recent arrival first.
  - `AgentTouch = { key: string; product: string | null; owner: string; ownerActor: string; label: string | null; write: boolean; activity: string | null }` (server-internal RPC arg; `ownerActor` is `u:{id}`, never sent to clients).
  - `ArtifactEventSchema` gains the presence frame; `hello` gains `you: PresenceKey.optional()` appended last.
  - `GetArtifactInputSchema` and each `ArtifactData*InputSchema` gain `activity: z.string().max(80).optional()` appended last.
  - Mock: `ArtifactEventsMock.emitPresence(id: string, viewers: PresenceEntry[], you?: string): number`; hello carries `you` when set via `mock.presenceYou?.(id)`.

- [ ] **Step 1: Write the failing tests** in `packages/shared/test/presence.test.ts`:
  - `ANIMALS has 50 to 70 unique ids and names` (`new Set(ids).size === ANIMALS.length`, length in [50, 70], names match `/^[A-Z][A-Za-z ]+$/`).
  - `presence frame parses through ArtifactEventSchema` (a frame with one entry of each kind).
  - `presence entry has no email, id or anonId field` (`PresenceEntrySchema.strict()` style check: parse an object with `email` and assert it is stripped; assert `Object.keys(PresenceEntrySchema.shape)` equals `["key","kind","name","named","color","animal","agent"]`).
  - `names over 80 chars are refused` and `activity over 80 is refused on GetArtifactInputSchema`.
  - `an old-shape hello (no you) still parses`.
  - In `events.mock.test.ts`: `emitPresence sends one presence frame to each open socket`.
- [ ] **Step 2: Run** `pnpm --filter @oa/shared exec vitest run test/presence.test.ts test/events.mock.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `packages/shared/src/presence.ts` and the schema/mock changes above. `schemas.ts` imports from `presence.ts` (not the reverse).
- [ ] **Step 4: Record the contract** in `HOSTED_CONTRACT.md`: a "Presence (both tiers)" section (frame, entry fields and trust levels, cookie, ping/pong, timings, `?ping=1&since=` query on `R.events`) and CHANGED rows for `ArtifactEvent.hello` (`you?`), `ArtifactEventSchema` (`presence`), `GetArtifactInput` and `ArtifactData*Input` (`activity?`). Update the `ArtifactEventSchema` doc comment in `schemas.ts` (frames list; client messages: only `"ping"`, anything else still closes 1008).
- [ ] **Step 5: Run** `pnpm --filter @oa/shared test && pnpm --filter @oa/shared typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(shared): viewer presence contract`.

### Task 2: Pure roster builder

**Files:**
- Create: `apps/server/src/runtime/roster.ts`
- Test: `apps/server/test/roster.test.ts`

**Interfaces:**
- Consumes: Task 1 `PresenceEntry`, `ANIMALS`, `PRESENCE_PALETTE_SIZE`, `PRESENCE_LIST_MAX`.
- Produces:
  - `type PresenceIdentity = { key: string; kind: "person" | "anon"; name: string | null; guest: boolean }` (what the route passes; `name` null for anon or nameless).
  - `type SeatRow = { key: string; kind: "person" | "anon"; name: string | null; guest: boolean; since: number }` (one per live socket or grace row).
  - `type AgentRow = { key: string; product: string | null; owner: string; ownerActor: string; label: string | null; since: number; seen: number; lastWrite: number | null; activity: string | null }`.
  - `buildRoster(seats: SeatRow[], agents: AgentRow[], now: number): { viewers: PresenceEntry[]; total: number; labels: Map<string, Map<string, string>> }` where `labels` is ownerActor → (agent key → token label), for owner-only variants.
  - `colorOf(key: string): number` (stable hash mod 9; an agent's key is per session, so each session gets its own color), `cleanName(s: string | null): string | null` (trim, collapse whitespace, strip control and bidi-override chars, cut to 80 code points).

- [ ] **Step 1: Write the failing tests** (`roster.test.ts`):
  - `two seats with one key show once, at the earliest since`.
  - `most recent arrival first across people, anon and agents`.
  - `nameless person is "Member", nameless guest is "Guest", named: false`.
  - `anon names are "Anonymous " + animal; two anons never share an animal` (force a hash clash by picking two keys with the same `hash % ANIMALS.length`).
  - `animal assignment is stable for the earlier arrival when a later one joins`.
  - `ANIMALS.length + 1 anons: the last gets a numbered name ("Anonymous Duck 2")`.
  - `agents: same product gets "-2", "-3" in arrival order ("Claude Code", "Claude Code-2")`; `no product names it "Agent"`.
  - `agent state is "editing" when lastWrite is within AGENT_PRESENT_MS, else "viewing"`; `agents seen more than AGENT_PRESENT_MS ago are dropped`.
  - `token label is never in viewers, only in labels for the ownerActor`.
  - `cleanName cuts a 500-char name to 80 and strips U+202E`.
  - `roster over 100 is cut to 100 with total = full count`.
  - `JSON of the roster never contains ownerActor or "u:"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/roster.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `roster.ts`. Animal pick: preferred index `hash(key) % ANIMALS.length`, then the next free index, assigned in arrival order (oldest first) so earlier arrivals keep theirs; when all are taken, cycle with " 2", " 3". Use one small non-crypto hash (FNV-1a 32) for both color and animal.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): presence roster builder`.

### Task 3: Presence on the ArtifactRuntime events sockets

**Files:**
- Modify: `apps/server/src/runtime/do.ts` (SCHEMA `:280-315`, `SocketMeta :321`, tags `:329-340`, `fetch :1063-1133`, `alarm :1326-1385`, `webSocketMessage`/`webSocketClose :1454-1476`, `closeSockets`, `destroy`)
- Test: `apps/server/test/presence.do.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 `buildRoster`, `SeatRow`; Task 1 constants and `PRESENCE_PING/PONG`.
- Produces (used by Task 4):
  - Upgrade headers from the route: `EVENTS_PRESENCE_HEADER = "X-OA-Presence"` (JSON `PresenceIdentity`, absent = this socket is not counted and gets no presence frames, e.g. embeds), `EVENTS_SINCE_HEADER = "X-OA-Since"` (ms epoch or absent), `EVENTS_PING_HEADER = "X-OA-Ping"` (`"1"` = this client pings).
  - `SocketMeta = { t: number; named?: boolean; p?: SeatRow & { ping: boolean } }`.
  - Tag `PRESENCE_TAG = "~pr"` on counted sockets.
  - SQLite tables: `presence_left (key text primary key, kind, name, guest, since, until)`, `presence_state (id = 1, hash text, sent_at integer)`. (`presence_agent` comes in Task 6.)
  - `private presenceChanged(): Promise<void>` (coalesced flush), `private flushPresence(): void`, `pendingPresence(): { left: number; sentAt: number | null }` (tests).
  - `hello` frame carries `you` (the socket's key) when counted.

- [ ] **Step 1: Write the failing tests** (`presence.do.test.ts`, via `runtimeStub(env, id).fetch("https://runtime.invalid/events", { headers })` and `runInDurableObject` with `instance.now` overridden, as in `events.test.ts` / `runtime.do.test.ts`):
  - `hello carries you; the joiner gets the current roster right after hello`.
  - `a second socket's join reaches the first as one presence frame`.
  - `three joins inside PRESENCE_COALESCE_MS send one frame, flushed by the alarm`.
  - `two sockets of one key show once; closing one keeps the face`.
  - `a clean close leaves after PRESENCE_GRACE_MS, not before` (no frame at +4 s, frame at +5 s via alarm).
  - `a reconnect inside the grace keeps the original since and position` (close, reopen with a later `X-OA-Since`, roster order unchanged).
  - `X-OA-Since in the future or older than SOCKET_TTL_MS + grace is clamped`.
  - `"ping" gets "pong" and does not close the socket; any other message still closes 1008` (keep `events.test.ts` "any client message closes the socket (1008)" passing).
  - `a pinging socket with no auto-response for PRESENCE_STALE_MS is closed by the alarm and leaves` (Review Focus 3).
  - `a socket opened without X-OA-Ping is never swept as stale` (Review Focus 1).
  - `while counted sockets exist the alarm is armed at most PRESENCE_SWEEP_MS ahead; with none it is not re-armed for presence`.
  - `after a fresh instance on the same storage, the roster is rebuilt from attachments and presence_left` (Review Focus 2).
  - `a socket without X-OA-Presence gets no presence frames and is not counted` (embeds).
  - `closeSockets and destroy clear presence_left and presence_state`.
  - `presence frames carry no "u:", "ip:" or email substrings` (owner name set to a value containing "@" is fine; assert the attachment actor never leaks).
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/presence.do.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Constructor: `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PRESENCE_PING, PRESENCE_PONG))` (applies to data sockets too; harmless).
  - `fetch` (`/events`): parse `X-OA-Presence` with a zod schema (400 on invalid), build the seat with `since = presence_left.since ?? clamp(X-OA-Since)` and delete that `presence_left` row; push `PRESENCE_TAG`; hello includes `you`; send the roster to the joiner; `presenceChanged()`; `armAt(min(t + SOCKET_TTL_MS, now + PRESENCE_SWEEP_MS))` when counted.
  - `webSocketClose` (and a new `webSocketError` with the same body): for a counted socket whose key has no other open counted socket, upsert `presence_left` with `until = now + PRESENCE_GRACE_MS` and `armAt(until)`.
  - `presenceChanged`: if `now - sent_at >= PRESENCE_COALESCE_MS` flush now, else `armAt(sent_at + PRESENCE_COALESCE_MS)`.
  - `flushPresence`: seats from `getWebSockets(PRESENCE_TAG)` attachments plus unexpired `presence_left`; `buildRoster`; skip when the JSON hash equals `presence_state.hash`; else send one serialized frame to all `PRESENCE_TAG` sockets and store hash and `sent_at`.
  - `alarm`: before the TTL loop, close pinging counted sockets whose `getWebSocketAutoResponseTimestamp(ws) ?? t` is older than `PRESENCE_STALE_MS` (close 1001 "stale", then the grace path); delete expired `presence_left`; flush if anything changed or a coalesce is due; include `now + PRESENCE_SWEEP_MS` (counted sockets open), the earliest `until`, and a pending coalesce in `next`. The early return at `:1334` also checks `presence_left`.
- [ ] **Step 4: Run** the test file plus `test/events.test.ts test/runtime.do.test.ts test/alarm.cpu.test.ts`. Expected: PASS. Existing `events.test.ts` tests that read frames in order get a helper `nextOf(type)` that skips `presence` frames.
- [ ] **Step 5: Commit** `feat(server): viewer presence on the events socket`.

### Task 4: Events route passes presence identity

**Files:**
- Modify: `apps/server/src/runtime/routes.ts:417-462`, `apps/server/src/auth/keys.ts` (`KEY_LABELS` + `"oa:presence"`)
- Create: `apps/server/src/runtime/presence-key.ts` (`presenceKey`)
- Test: `apps/server/test/events.test.ts` (new `describe("events socket: presence")`), `apps/server/test/keys.test.ts`

**Interfaces:**
- Consumes: Task 3 headers; Task 1 `PRESENCE_COOKIE`, `PRESENCE_ID_RE`.
- Produces: `presenceKey(env: Pick<Env,"SESSION_SECRET">, artifactId: string, identity: string): Promise<string>` = first 16 chars of `hmacSign(deriveKey(env,"oa:presence"), artifactId + "\0" + identity)`. Identities: `u:{userId}`, `p:{oa_pid}`, `s:{random}` (no valid cookie: one face per socket), `a:{session or connection}` (Task 6).

- [ ] **Step 1: Write the failing tests** in `events.test.ts`:
  - `two tabs of one signed-in person show once to a third viewer`.
  - `an anonymous viewer shows as Anonymous <Animal>; two tabs with one oa_pid show once`.
  - `the anonymous frame never carries the anonId, the oa_pid or the IP` (open with both an `oa.anonId`-minted token in play and a known `oa_pid`; assert neither string, nor `198.51.100.`, appears in any frame).
  - `a guest and a stranger on a public link see names but never emails` (owner with `name: null` shows as "Member"; owner email absent from every frame JSON).
  - `the presence key differs per artifact for the same person`.
  - `a malformed or 65-char oa_pid gives a per-socket face, not an error` (Review Focus 4).
  - `embed sockets (?embed=1 and X-OA-Embed) are not counted and get no presence frames`.
  - `?ping=1 and ?since= reach the DO; a non-numeric since is ignored`.
  - `keys.test.ts`: the existing distinct-keys test covers the new label.
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/events.test.ts test/keys.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in the `EVENTS` handler: skip presence when embed; signed-in: identity `u:{id}`, `name: cleanName(user.name)`, `guest: user.role === "guest"`, kind `person`; anonymous: `p:{oa_pid}` when it matches `PRESENCE_ID_RE`, else `s:{newId()}`, kind `anon`, name null. Read the cookie with Hono's `getCookie`. Pass the three headers.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): events route sends the presence identity`.

### Task 5: Server-issued MCP session id

**Files:**
- Create: `apps/server/src/mcp/session.ts`
- Modify: `apps/server/src/auth/keys.ts` (`"oa:mcp-session"`), `apps/server/src/mcp/server.ts:30-46` (`McpContext.connection`, `McpContext.session`), `apps/server/src/index.ts:47-70` (`mcpWithPat`), `apps/server/src/mcp/oauth.ts:79-93` (`apiHandler`)
- Test: `apps/server/test/mcp-session.test.ts` (new)

**Interfaces:**
- Produces:
  - `MCP_SESSION_HEADER = "Mcp-Session-Id"`.
  - `issueMcpSession(env, userId: string): Promise<string>` = `ms_<22 random base64url>.<hmac16>` bound to `userId`.
  - `verifyMcpSession(env, userId: string, value: string | null): Promise<string | null>` (the random part, or null when absent, over 128 chars or the signature fails).
  - `withMcpSession(req: Request, env: Env, userId: string, run: (session: string | null) => Promise<Response>): Promise<Response>`: verifies the request header; when the request body is a JSON-RPC `initialize` (single object, `method === "initialize"`), adds a freshly issued `Mcp-Session-Id` to the response headers.
  - `McpContext` gains `connection: string` (`pat:{tokenId}` or `oauth:{clientId}`) and `session: string | null`.
- Note: the stateless handler rejects `sessionIdGenerator` and its transport ignores `Mcp-Session-Id` when stateless, so the header is added outside the SDK. Tools never see the raw header.

- [ ] **Step 1: Write the failing tests** (`mcp-session.test.ts`, using `connect`/`tool` from `test/mcp-helpers.ts`):
  - `initialize returns an Mcp-Session-Id; tools/call does not issue a new one`.
  - `a session id signed for another user verifies as null`.
  - `a tampered or 129-char session id verifies as null and the call still works`.
  - `a client that never echoes the header still works (session null)`.
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/mcp-session.test.ts test/mcp.auth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire both entry points (`mcpWithPat`, `apiHandler`) through `withMcpSession`. Read the body from a clone of the capped request.
- [ ] **Step 4: Run** the same command plus `test/mcp.tools.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): server-issued Mcp-Session-Id`.

### Task 6: Agents on the roster

**Files:**
- Create: `apps/server/src/runtime/agent-presence.ts`
- Modify: `apps/server/src/runtime/do.ts` (table `presence_agent`, `touchAgent` RPC, optional trailing `touch?: AgentTouch` on `scheduleIndex`, `get`, `list`, `query`, `count`, `set`, `setRaw`, `update`, `updateRaw`, `delete`; alarm expiry; owner-only label variants in `flushPresence`), `apps/server/src/services/artifacts.ts` (`enqueueIndex`, `publish`, `restoreVersion` take `touch?: AgentTouch`), `apps/server/src/mcp/server.ts` (`ToolEnv.touch(id, write, activity)`), `apps/server/src/mcp/tools/artifacts.ts` (`publish_artifact`, `get_artifact`), `apps/server/src/mcp/tools/data.ts` (all six), `apps/server/src/routes/artifacts.ts` (GET `R.artifact`, publish, restore for PAT callers), `apps/server/src/runtime/routes.ts` (data routes for PAT callers), `apps/server/src/mcp/instructions.ts`
- Test: `apps/server/test/presence.agents.test.ts` (new)

**Interfaces:**
- Consumes: Task 5 `McpContext.session`, `.connection`; Task 4 `presenceKey`; Task 2 `AgentRow`, `buildRoster(...).labels`.
- Produces:
  - `agentTouch(env, artifactId: string, o: { user: Member; product: string | null; label: string | null; session: string | null; connection: string; write: boolean; activity: string | null }): Promise<AgentTouch>`: key = `presenceKey(env, artifactId, "a:" + (session ?? connection))`, `owner = cleanName(user.name) ?? "Member"` (never the email), `ownerActor = "u:" + user.id`, activity cut to 80.
  - `touchAgentLater(env, exec: Pick<ExecutionContext,"waitUntil"> | undefined, artifactId, o): void`: the one extra DO call (`runtimeStub(env, id).touchAgent(touch)` in `waitUntil`, errors logged as `presence_touch_failed`).
  - DO `touchAgent(t: AgentTouch): Promise<void>`: upsert row (`since` kept, `seen = now`, `last_write = now` when `write`, activity replaced when given), `presenceChanged()`, `armAt(seen + AGENT_PRESENT_MS)`.
  - Product: OAuth = `clientName`; PAT = none (label carries the token label, owner only). REST with a PAT: connection `pat:{tokenId}`, no session.
  - Publish activity = `input.message`.
- [ ] **Step 1: Write the failing tests** (`presence.agents.test.ts`):
  - `an MCP get_artifact puts the agent on an open viewer's roster as "<product>", owner name, Viewing`.
  - `a publish through MCP makes it Editing with the change note as activity` (and costs no extra DO call: the touch rides `scheduleIndex`).
  - `a data write through artifact_data_set makes it Editing` (rides the DO call).
  - `two MCP sessions of one client show as "Claude Code" and "Claude Code-2"; one session's calls show once`.
  - `a client without the session header gets one face per connection`.
  - `an agent drops off AGENT_PRESENT_MS after its last request` (clock override, alarm).
  - `a PAT agent shows as "Agent"; its token label reaches only sockets of the token's owner`.
  - `an owner with no name gives agent.owner "Member", never the email`.
  - `activity over 80 chars is refused by the tool input; activity never appears for a non-agent`.
  - `REST GET R.artifact with a PAT adds the agent; with a session cookie it does not`.
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/presence.agents.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Instructions: add one line to `INSTRUCTIONS` asking agents to pass `activity` (a few words on what they are doing, at most 80 characters) on reads and data calls. Regenerate the skill and tool manifest with `pnpm --filter @oa/server gen` and commit the outputs.
- [ ] **Step 4: Run** the test file plus `test/mcp.tools.test.ts test/events.test.ts test/runtime.do.test.ts test/json-shapes.snapshot.test.ts test/mcp-publish.cpu.test.ts`. Expected: PASS, snapshot unchanged.
- [ ] **Step 5: Commit** `feat(server): AI agents on the presence roster`.

### Task 7: Dashboard presence client

**Files:**
- Create: `apps/dashboard/src/viewer/presenceId.ts`, `apps/dashboard/src/viewer/usePresence.ts`
- Modify: `apps/dashboard/src/viewer/liveEvents.ts`, `apps/dashboard/src/viewer/useLiveVersions.ts` (pass `onPresence` through, ignore presence in `onEvent`), `apps/dashboard/src/viewer/Shell.tsx`
- Test: `apps/dashboard/test/live-events.test.ts`, `apps/dashboard/test/presence.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1 schemas, constants, mock `emitPresence`.
- Produces:
  - `presenceId(): string`: reads `oa_pid` from `document.cookie`, else mints 22 random base64url chars and writes the session cookie (Global Constraints attributes). Never touches `oa.anonId`; never throws.
  - `eventsUrl(id, embed, o?: { since?: number })` adds `ping=1` always and `since` when known.
  - `ArtifactEventsOptions.onPresence?: (f: PresenceFrame, you: string | undefined) => void`; the socket sends `PRESENCE_PING` every `PRESENCE_PING_MS` while open (one interval per socket, cleared on close), ignores `"pong"`, and keeps the first `since` it saw for reconnects (4408 and backoff).
  - `usePresence(): { others: PresenceEntry[]; total: number; onPresence }` (drops `you`, clears on gone).
- [ ] **Step 1: Write the failing tests:**
  - `live-events.test.ts`: `sends "ping" every 30 s and only "ping"` (fake timers), `a 4408 reconnect carries since and ping=1`, `presence frames go to onPresence, not onEvent`, `embed mode never sends a presence id or since`.
  - `presence.test.tsx`: `presenceId mints once and reuses the cookie`, `presenceId never reads or writes oa.anonId`, `usePresence hides you and keeps order`, `a gone artifact clears the roster`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard exec vitest run test/live-events.test.ts test/presence.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The anonymous cookie is set before the first connect so the upgrade carries it; signed-in viewers set it too (the server ignores it for them).
- [ ] **Step 4: Run** the same command plus `test/live-versions.test.tsx test/shell.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): presence client on the events socket`.

### Task 8: Animal icon set

**Files:**
- Create: `apps/dashboard/src/viewer/presence/animals.tsx`
- Test: `apps/dashboard/test/animals.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1 `ANIMALS`, `AnimalId`.
- Produces: `AnimalIcon({ id, className }: { id: AnimalId; className?: string }): JSX.Element` (an `aria-hidden` SVG, `stroke="currentColor"`, `fill="none"`, `strokeWidth={2}`, round caps and joins, `viewBox="0 0 24 24"`). Lucide animals come from `lucide-react`; the 45 others are inline path data in this file, drawn by Design in the same style (4A).

- [ ] **Step 1: Write the failing tests:** `every ANIMALS id has an icon` (render each; assert an `svg` with `viewBox="0 0 24 24"`), `lucide: true ids render the lucide-react icon`, `drawn icons use only stroke, never fill` (no `fill` other than `none` in the markup), `no two drawn icons share path data`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard exec vitest run test/animals.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with Design's drawn paths (Design delivers them as SVG; the implementer only transcribes). This task waits for all 45 drawings; no placeholder icons ship.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Verify visually** with the `proofshot` skill: every icon at 15px on each of the 9 palette colors, light and dark; send the sheet to Design.
- [ ] **Step 6: Commit** `feat(viewer): presence animal icons`.

### Task 9: Presence stack UI

**Files:**
- Create: `apps/dashboard/src/viewer/presence/PresenceStack.tsx`, `PresenceAvatar.tsx`, `PresenceCard.tsx`; palette tokens `--oa-presence-0` … `--oa-presence-8` in `apps/dashboard/src/viewer/viewer.css` (one set, no dark override, per 4A)
- Modify: `apps/dashboard/src/viewer/TitleBar.tsx:117-145` (new prop `presence?: ReactNode`) and `:264` (render it first in the right group, before the version chip), `FullScreenEscape.tsx` (the same stack in the full-screen pill, placed per the Design page), `Shell.tsx` (renders `PresenceStack` unless embed or gone)
- Test: `apps/dashboard/test/presence-stack.test.tsx` (new), `apps/dashboard/e2e/presence.spec.ts` (new, mock)

**Interfaces:**
- Consumes: Task 7 `usePresence`; Task 8 `AnimalIcon`; Task 1 `PresenceEntry`.
- Produces: `PresenceStack({ others, total }: { others: PresenceEntry[]; total: number })`; `PresenceAvatar({ entry, size }: { entry: PresenceEntry; size: 28 | 40 })` with `data-shape="circle" | "square"`; `presenceInitials(e: PresenceEntry): string` (from the name when `named`, else two letters from `key`; never an email; an agent shows its owner's initials). Card copy (3A): person = name; anon = "Anonymous <Animal>" only; agent = name, "<Owner>'s agent · Viewing" or "· Editing", the activity in quotes with the caption "In the agent's own words"; a PAT agent with no product is named "Agent". The "+N" list header reads "<N> more here".

- [ ] **Step 1: Write the failing tests** (`presence-stack.test.tsx`):
  - `nobody else: renders nothing`.
  - `5 others: 3 faces then "+2"; exactly 4: all 4 faces, no "+1"`.
  - `"+N" opens a list headed "N more here" with the rest, agents with owner and state`.
  - `faces sit side by side (no negative margin) in arrival order`.
  - `clicking a face opens the card with the name only` (no `@` anywhere in the card's text).
  - `an anonymous card says "Anonymous Duck" and nothing else, with the duck icon`.
  - `an agent face is data-shape="square" with the owner's initials; its card shows "<Owner>'s agent · Editing", the quoted note and "In the agent's own words"`.
  - `color index i maps to --oa-presence-i`.
  - `a 500-char or HTML name renders as text, cut to 80` (Review Focus 5).
  - `each face has an accessible name; the stack is a labeled group`.
  - e2e `presence.spec.ts` (mock, `window.__oaEvents.emitPresence`): faces first in the right group, before the version chip; `/full` shows the stack; at 390px one face plus "+N"; light and dark screenshots; embed shows nothing; a gone artifact shows no stack.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard exec vitest run test/presence-stack.test.tsx` and `pnpm --filter @oa/dashboard exec playwright test e2e/presence.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** on `@oa/ui/shadcn` `Avatar`/`Popover`/`Tooltip` (hover = name tooltip, click = card). Do not reuse `UserAvatar` (it hashes the email).
- [ ] **Step 4: Run** the same commands plus `pnpm --filter @oa/dashboard exec playwright test e2e/viewer-shadcn.spec.ts e2e/full-screen.spec.ts e2e/m2-a11y.spec.ts`. Expected: PASS.
- [ ] **Step 5: Verify visually** with the `proofshot` skill (header, card, "+N", phone, `/full`, light and dark) against the Design page; send the shots to Design.
- [ ] **Step 6: Commit** `feat(viewer): who's viewing in the header`.

### Task 10: Real end-to-end presence

**Files:**
- Create: `apps/dashboard/e2e/real/presence.spec.ts`

**Interfaces:**
- Consumes: everything above; `apps/dashboard/e2e/real/fixtures.ts` sign-in helpers and `mcp-client.ts`.

- [ ] **Step 1: Write the tests:**
  - `a member and an anonymous viewer on a public artifact see each other` (two browser contexts; anonymous sees the member's name; member sees "Anonymous <Animal>").
  - `two tabs of one member show once to the other viewer`.
  - `a closed tab leaves within 7 s`.
  - `an MCP client reading the artifact appears as a square agent face` (expiry is covered by Task 6's clock-driven test).
  - `no frame seen by the anonymous context contains an "@"` (collect frames with `page.on("websocket")`).
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test:e2e:real -- e2e/real/presence.spec.ts`. Expected: PASS.
- [ ] **Step 3: Run the full suites** `pnpm test && pnpm typecheck && pnpm lint`. Expected: PASS.
- [ ] **Step 4: Commit** `test(e2e): viewer presence end to end`.

---

## Spec coverage

| Spec item | Task |
|---|---|
| Goal 1 stack, ordering, one face per person, you hidden | 2, 3, 7, 8 |
| Goal 2 initials, no photos; names never emails, "Member"/"Guest" | 2, 4, 8 |
| Goal 3 anonymous animals, sticky per browser session, unique per artifact, numbered when exhausted | 1, 2, 4, 7 |
| Goal 4 everyone sees everyone | 3, 4 |
| Goal 5 card, name only | 9 |
| Goal 6 agents, shape (1A), trust levels, session, unique names, activity, state | 5, 6, 9 |
| Anti-goals: no leak, no cross-artifact linking, free plan, ghosts | 1, 3, 4 |
| Reconnect grace and since | 3, 7 |
| Embeds not counted (Section 10, builder's lean: no) | 3, 4, 9 |
| `/full`, phones, deleted/no access | 9 |
| Animal icons (4A, ~45 to draw) | 8 |
| RBAC: revocation closes sockets (P3 T7b) and so removes faces | 3 (close path); no new work |
| Contract record | 1 |
