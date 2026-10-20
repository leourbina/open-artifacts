/**
 * Hosted M1 MSW mocks, opt-in via createHandlers({ hosted }). Off (the
 * default), nothing here runs and every existing response is unchanged.
 *
 * In-memory store: spaces (a personal space per member, id = user id, plus
 * shared "Engineering" (caller manager), "Exec" (caller viewer, publicLinks
 * off) and "Clients" (no role: admin view)); space members keyed by user id;
 * group mappings; restricted groups; directory status; audit; a suspended
 * member (Carol) with personal artifacts to transfer. Every artifact gets
 * `space` and `can` (artifactCan) on each request; "Meeting notes" lives in
 * Engineering, so its access is "manager".
 *
 * Sign-in: AUTH.providers per options; the code flow accepts
 * HOSTED_MOCK_CODE for the last requested address (5 tries, then expired;
 * 10 failures per address, then 429; 6+ requests per address, then 429).
 * A successful verify signs the mock in as that address: an existing member,
 * a new member for MOCK_DOMAIN, else a guest (readOnly).
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import type { z } from "zod";
import type { ErrorCode } from "../errors.js";
import {
  HostedPublishInputSchema,
  MembersQuerySchema,
  MoveArtifactInputSchema,
  TRANSFER_PAGE,
  TransferArtifactInputSchema,
  TransferInputSchema,
} from "../hosted/artifacts.js";
import {
  type AuthProviders,
  CODE_POLICY,
  CodeRequestSchema,
  CodeVerifySchema,
  normalizeCode,
} from "../hosted/auth.js";
import {
  artifactCan,
  type CapReason,
  type DirectoryMode,
  type FeatureFlag,
  type GroupRef,
  type MySpace,
  type SpaceRef,
  type SpaceRole,
  type Tier,
} from "../hosted/core.js";
import type {
  AuditAction,
  AuditEvent,
  DirectoryGroup,
  SyncStatus,
} from "../hosted/directory.js";
import {
  type GroupMapping,
  GroupMappingPutSchema,
  type RestrictedGroup,
  SPACE_MANAGER_FIELDS,
  type Space,
  SpaceCreateSchema,
  type SpaceMember,
  SpaceMemberPutSchema,
  SpacePatchSchema,
} from "../hosted/spaces.js";
import { OtpLatestInputSchema } from "../hosted/test-hooks.js";
import { newId } from "../ids.js";
import type {
  AccessLevel,
  ArtifactSummary,
  Me,
  Member,
  PublishInput,
  Share,
} from "../schemas.js";

/** The code the mock accepts (any address). */
export const HOSTED_MOCK_CODE = "24681357";
/** The mock's verified Workspace domain. */
export const MOCK_DOMAIN = "example.com";

export type HostedMockOptions = {
  /** Sign-in mode (default "direct"). "access" lists only Access. */
  mode?: "access" | "direct";
  /** Direct-mode providers (default both). */
  providers?: ("google" | "email")[];
  /** Code requests need a Turnstile token (default false). Token "fail" is refused. */
  turnstile?: boolean;
  tier?: Tier | null;
  /** Directory binding mode (default "google"). */
  directory?: DirectoryMode;
  /** Sync unhealthy for 2 h: banner and tokensUnverified (default false). */
  unhealthy?: boolean;
  /** Extra FEATURES flags beyond the defaults (spaces, content_revocation, usage_off, plus the sync flag). guests_read_only is ignored: it is reported from the sign-in config (on when google or email is enabled). */
  features?: FeatureFlag[];
};

type Body = <T extends z.ZodType>(
  req: Request,
  schema: T,
) => Promise<
  | { error: Response; data?: undefined }
  | { data: z.infer<T>; error?: undefined }
>;

export type HostedCtx = {
  me: Me;
  members: Member[];
  artifacts: ArtifactSummary[];
  shares: Record<string, Share[]>;
  err: (code: ErrorCode, message: string, details?: unknown) => Response;
  body: Body;
  isAnon: (req: Request) => boolean;
};

type SpaceRow = {
  id: string;
  kind: "personal" | "shared";
  name: string;
  ownerId: string | null;
  allMembersRole: SpaceRole | null;
  publicLinks: boolean;
  createdAt: string;
};
type MemberRow = {
  userId: string;
  manualRole: SpaceRole | null;
  syncRole: SpaceRole | null;
  groups: GroupRef[];
};

const T0 = "2026-01-01T00:00:00.000Z";
const RANK: Record<SpaceRole, number> = { viewer: 1, editor: 2, manager: 3 };
const maxRole = (...r: (SpaceRole | null | undefined)[]): SpaceRole | null =>
  r.reduce<SpaceRole | null>(
    (a, b) => (b && (!a || RANK[b] > RANK[a]) ? b : a),
    null,
  );
const iso = () => new Date().toISOString();
const noContent = () => new HttpResponse(null, { status: 204 });
const page = <T>(all: T[], q: URLSearchParams, def = 50) => {
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || def));
  const start = Number(q.get("cursor") ? atob(q.get("cursor") as string) : 0);
  const next = start + limit;
  return HttpResponse.json({
    items: all.slice(start, next),
    nextCursor: next < all.length ? btoa(String(next)) : null,
  });
};
const mask = (email: string) => {
  const [l = "", d = ""] = email.split("@");
  return `${l.slice(0, 1)}***@${d}`;
};

export type HostedMock = ReturnType<typeof createHostedMock>;

export function createHostedMock(o: HostedMockOptions, c: HostedCtx) {
  const { me, members, artifacts, shares, err } = c;
  const notFound = () => err("not_found", "Not found");
  const directoryMode: DirectoryMode = o.directory ?? "google";
  const mode = o.mode ?? "direct";
  const providerIds = o.providers ?? ["google", "email"];

  // ---- members: status, identities, a departed member --------------------
  for (const m of members) {
    m.status = "active";
    m.identities = m.role === "owner" ? ["google"] : [];
  }
  const carol: Member = {
    id: "Cr7tNpQrSt8uVwXy",
    email: "carol@example.com",
    name: "Carol Departed",
    role: "member",
    lastSeenAt: "2025-12-01T10:00:00.000Z",
    status: "suspended",
    identities: ["google"],
  };
  const dan: Member = {
    id: "Dn8uPqRsTu9vWxYz",
    email: "dan@example.com",
    name: "Dan Contractor",
    role: "member",
    lastSeenAt: null,
    status: "active",
    identities: [],
  };
  members.push(carol, dan);
  /** Departed members' personal artifacts, counts only (admins never see titles). */
  const departed = new Map([[carol.id, { live: 2, deleted: 1 }]]);

  // ---- spaces --------------------------------------------------------------
  const spaces: SpaceRow[] = members.map((m) => ({
    id: m.id,
    kind: "personal",
    name: m.name ?? m.email,
    ownerId: m.id,
    allMembersRole: null,
    publicLinks: true,
    createdAt: T0,
  }));
  const shared = (id: string, name: string, x: Partial<SpaceRow> = {}) =>
    spaces.push({
      id,
      kind: "shared",
      name,
      ownerId: null,
      allMembersRole: null,
      publicLinks: true,
      createdAt: T0,
      ...x,
    });
  const ENG = "SpEngNpQrSt2uVwX";
  const EXEC = "SpExcNpQrSt3uVwX";
  const CLIENTS = "SpCliNpQrSt4uVwX";
  shared(ENG, "Engineering", { allMembersRole: "viewer" });
  shared(EXEC, "Exec", { publicLinks: false });
  shared(CLIENTS, "Clients");
  const ada = members[0] as Member;
  const bob = members[1] as Member;
  const G = {
    eng: { groupId: "gEng01", email: "eng@example.com", name: "Engineering" },
    exec: { groupId: "gExec02", email: "exec@example.com", name: "Exec" },
    sales: { groupId: "gSales03", email: "sales@example.com", name: "Sales" },
    contractors: {
      groupId: "gCon04",
      email: "contractors@example.com",
      name: "Contractors",
    },
  } satisfies Record<string, GroupRef>;
  /** Directory group membership (user ids), as sync would see it. */
  const groupMembers = new Map<string, string[]>([
    [G.eng.groupId, [bob.id]],
    [G.exec.groupId, [ada.id]],
    [G.sales.groupId, []],
    [G.contractors.groupId, [dan.id]],
  ]);
  /** Manual restricted flags (R.memberRestricted). */
  const manualRestricted = new Set<string>();
  const rows = new Map<string, MemberRow[]>([
    [
      ENG,
      [
        { userId: ada.id, manualRole: "manager", syncRole: null, groups: [] },
        {
          userId: bob.id,
          manualRole: null,
          syncRole: "editor",
          groups: [G.eng],
        },
      ],
    ],
    [
      EXEC,
      [
        {
          userId: ada.id,
          manualRole: null,
          syncRole: "viewer",
          groups: [G.exec],
        },
      ],
    ],
    [CLIENTS, []],
  ]);
  const mappings = new Map<string, GroupMapping[]>([
    [
      ENG,
      [
        {
          ...G.eng,
          role: "editor",
          memberCount: 1,
          lastSyncedAt: T0,
        },
      ],
    ],
    [
      EXEC,
      [
        {
          ...G.exec,
          role: "viewer",
          memberCount: 1,
          lastSyncedAt: T0,
        },
      ],
    ],
  ]);
  const restricted: RestrictedGroup[] = [
    { ...G.contractors, memberCount: 1, createdAt: T0 },
  ];
  const groups: DirectoryGroup[] = [
    { ...G.eng, memberCount: 1 },
    { ...G.exec, memberCount: 1 },
    { ...G.sales, memberCount: 4 },
    { ...G.contractors, memberCount: 1 },
  ];
  const audit: AuditEvent[] = [];
  const log = (
    action: AuditAction,
    target: AuditEvent["target"],
    spaceId: string | null = null,
    detail: Record<string, unknown> | null = null,
  ) =>
    audit.unshift({
      id: newId(),
      at: iso(),
      actor: { kind: "user", id: me.user.id, email: me.user.email },
      action,
      target,
      spaceId,
      reason: null,
      detail,
    });

  const unhealthySince = o.unhealthy
    ? new Date(Date.now() - 2 * 3600_000).toISOString()
    : null;
  const sync: SyncStatus = {
    mode: directoryMode,
    binding:
      directoryMode === "off"
        ? null
        : {
            provider: "google",
            customerId: "C01mock",
            domain: MOCK_DOMAIN,
            connectedBy: ada.email,
            connectedAt: T0,
          },
    healthy: directoryMode === "off" ? null : !o.unhealthy,
    state: directoryMode === "off" ? "never" : o.unhealthy ? "backoff" : "ok",
    unhealthySince,
    lastSuccessAt: directoryMode === "off" ? null : (unhealthySince ?? iso()),
    lastError: o.unhealthy
      ? { at: iso(), message: "Google returned 503" }
      : null,
    nextRunAt: null,
    staleAt: null,
    alertedAt: null,
    customerMismatch: null,
    held:
      directoryMode === "google"
        ? [
            {
              ...G.sales,
              wouldRemove: 4,
              members: 4,
              since: T0,
            },
          ]
        : [],
  };

  // ---- derived views --------------------------------------------------------
  const isAdmin = () => me.user.role === "owner" || me.user.role === "admin";
  const findSpace = (id: unknown) => spaces.find((s) => s.id === id);
  const memberOf = (id: string) => members.find((m) => m.id === id);
  /** guests_read_only: P2's authConfig.guestsReadOnly, true whenever google or email sign-in is on. */
  const guestsReadOnly = () => mode === "direct" && providerIds.length > 0;
  const restrictionOf = (userId: string) => {
    const gs = restricted
      .filter((g) => groupMembers.get(g.groupId)?.includes(userId))
      .map((g) => ({ groupId: g.groupId, email: g.email, name: g.name }));
    const manual = manualRestricted.has(userId);
    return manual || gs.length > 0 ? { manual, groups: gs } : null;
  };
  const capOf = (u: Member | undefined): CapReason | null =>
    !u
      ? null
      : u.role === "guest" && guestsReadOnly()
        ? "guest"
        : restrictionOf(u.id)
          ? "restricted"
          : null;
  const cap = (): CapReason | null => capOf(me.user);
  const roleIn = (s: SpaceRow, userId = me.user.id): SpaceRole | null => {
    if (s.kind === "personal") return s.ownerId === userId ? "manager" : null;
    const u = memberOf(userId);
    const r = rows.get(s.id)?.find((x) => x.userId === userId);
    // allMembersRole never reaches guests or restricted members.
    const all =
      u && u.role !== "guest" && !restrictionOf(u.id) ? s.allMembersRole : null;
    return maxRole(r?.manualRole, r?.syncRole, all);
  };
  const ref = (s: SpaceRow): SpaceRef => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    publicLinks: s.publicLinks,
  });
  const view = (s: SpaceRow): Space => ({
    ...ref(s),
    owner: (() => {
      const u = s.ownerId ? memberOf(s.ownerId) : undefined;
      return u ? { id: u.id, email: u.email, name: u.name } : null;
    })(),
    allMembersRole: s.allMembersRole,
    myRole: roleIn(s),
    memberCount: s.kind === "personal" ? 1 : (rows.get(s.id)?.length ?? 0),
    artifactCount: artifacts.filter(
      (a) => a.space?.id === s.id && a.deletedAt === null,
    ).length,
    createdAt: s.createdAt,
  });
  const memberView = (r: MemberRow): SpaceMember | null => {
    const u = memberOf(r.userId);
    if (!u) return null;
    const role = maxRole(r.manualRole, r.syncRole) as SpaceRole;
    return {
      userId: u.id,
      user: { id: u.id, email: u.email, name: u.name },
      status: u.status ?? "active",
      role,
      source:
        r.manualRole && RANK[r.manualRole] >= RANK[role] ? "manual" : "sync",
      manualRole: r.manualRole,
      syncRole: r.syncRole,
      groups: r.groups,
      cap: capOf(u),
    };
  };
  /** Can the caller see this shared space (member or org admin)? */
  const visible = (s: SpaceRow) =>
    s.kind === "personal" ? s.ownerId === me.user.id : !!roleIn(s) || isAdmin();
  const levelIn = (s: SpaceRow): AccessLevel | null => {
    if (s.kind === "personal") return s.ownerId === me.user.id ? "owner" : null;
    const r = roleIn(s);
    return r === "manager" ? "manager" : r;
  };

  const features = (): FeatureFlag[] => [
    ...new Set<FeatureFlag>([
      "spaces",
      ...(guestsReadOnly() ? (["guests_read_only"] as const) : []),
      "content_revocation",
      "usage_off",
      ...(directoryMode === "google"
        ? (["sync_google"] as const)
        : directoryMode === "frozen"
          ? (["sync_frozen"] as const)
          : []),
      // FEATURES can't set guests_read_only.
      ...(o.features ?? []).filter((f) => f !== "guests_read_only"),
    ]),
  ];
  const providers = (): AuthProviders =>
    mode === "access"
      ? { mode, providers: [{ id: "access", start: "/auth/login" }] }
      : {
          mode,
          providers: [
            ...(providerIds.includes("google")
              ? [
                  {
                    id: "google" as const,
                    start: "/auth/login/google",
                    domains: [MOCK_DOMAIN],
                  },
                ]
              : []),
            ...(providerIds.includes("email")
              ? [
                  {
                    id: "email" as const,
                    domainCodes: !providerIds.includes("google"),
                    guests: true,
                    ...(o.turnstile
                      ? { turnstileSiteKey: "1x00000000000000000000AA" }
                      : {}),
                  },
                ]
              : []),
          ],
        };

  /** Refresh Me's hosted fields and every artifact's space/can. Runs before each request. */
  const refresh = () => {
    me.instance.hosted = true;
    me.instance.tier = o.tier === undefined ? "business" : o.tier;
    me.instance.signIn = {
      mode,
      providers: providers().providers.map((p) => p.id),
    };
    me.instance.features = features();
    const unhealthy = sync.healthy === false;
    me.instance.directory = {
      mode: directoryMode,
      healthy: sync.healthy,
      unhealthySince: sync.unhealthySince,
      banner: unhealthy && isAdmin(),
      tokensUnverified: unhealthy && isAdmin(),
    };
    for (const m of members) m.restriction = restrictionOf(m.id);
    const myCap = cap();
    me.auth = {
      method: me.auth?.method ?? (mode === "access" ? "access" : "google"),
      readOnly: myCap !== null,
      cap: myCap,
      expiresAt: me.auth?.expiresAt ?? "2026-12-31T00:00:00.000Z",
    };
    me.personalSpaceId = me.user.id;
    me.spaces = spaces
      .filter((s) => s.kind === "shared" && roleIn(s))
      .map((s): MySpace => ({ ...ref(s), myRole: roleIn(s) as SpaceRole }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const a of artifacts) {
      const s =
        findSpace(a.space?.id) ??
        findSpace(a.owner.id) ??
        (spaces[0] as SpaceRow);
      a.space = ref(s);
      a.can = artifactCan(a.access, {
        personal: s.kind === "personal",
        cap: cap(),
      });
    }
  };

  // Seed: "Meeting notes" in Engineering, where the caller is manager.
  const notes = artifacts.find((a) => a.title === "Meeting notes");
  if (notes) {
    notes.space = ref(findSpace(ENG) as SpaceRow);
    notes.access = "manager";
  }
  refresh();

  // ---- code flow state -----------------------------------------------------
  let pending: { email: string; attempts: number; next: string } | null = null;
  const requests = new Map<string, number>();
  const fails = new Map<string, number>();

  // ---- publish hook (used by POST R.artifacts) -----------------------------
  const publishSchema = HostedPublishInputSchema;
  /** Checks spaceId; returns a refusal, or the space to place a new artifact in. */
  const checkPublish = (
    input: PublishInput & { spaceId?: string },
    existing: ArtifactSummary | undefined,
  ): Response | { space: SpaceRow | null } => {
    if (input.spaceId === undefined)
      return {
        space: existing
          ? null
          : cap()
            ? null
            : (findSpace(me.user.id) as SpaceRow),
      };
    if (existing)
      return err("use_move", "spaceId is only valid when creating; use move");
    const s = findSpace(input.spaceId);
    if (!s || !visible(s)) return notFound();
    const r = roleIn(s);
    if (cap() || !r || r === "viewer")
      return err("space_forbidden", "You can't publish to this space");
    return { space: s };
  };
  const placeNew = (a: ArtifactSummary, s: SpaceRow | null) => {
    if (cap() && !s) return;
    const sp = s ?? (findSpace(me.user.id) as SpaceRow);
    a.space = ref(sp);
    a.access = levelIn(sp) ?? "owner";
    refresh();
  };
  /** Making an artifact public in a space whose publicLinks is off: 403 public_links_off. */
  const refusePublic = (
    space: { publicLinks: boolean } | null | undefined,
    visibility: string | undefined,
  ) =>
    visibility === "public" && space && !space.publicLinks
      ? err("public_links_off", "Public links are off in this space")
      : null;
  /** A create by a capped caller (no spaceId) is refused too. */
  const refuseCappedCreate = () =>
    cap() ? err("space_forbidden", "Read-only accounts can't publish") : null;

  // ---- handlers --------------------------------------------------------------
  const authed =
    (
      fn: (ctx: {
        request: Request;
        params: Record<string, unknown>;
      }) => Response | Promise<Response>,
    ) =>
    (ctx: { request: Request; params: Record<string, unknown> }) =>
      c.isAnon(ctx.request)
        ? err("unauthorized", "Authentication required")
        : fn(ctx);
  const sharedSpace = (id: unknown): SpaceRow | Response => {
    const s = findSpace(id);
    if (!s || !visible(s)) return notFound();
    return s;
  };
  const syncOff = () =>
    directoryMode !== "google"
      ? err("directory_sync_off", "Directory sync is off or frozen")
      : null;
  const sp = "*/api/v1/spaces/:id";
  const validSuccessor = (u: Member | undefined): u is Member =>
    !!u &&
    u.role !== "guest" &&
    (u.status ?? "active") === "active" &&
    !restrictionOf(u.id);

  const handlers: HttpHandler[] = [
    http.all("*", () => {
      refresh();
      return undefined;
    }),
    // -- sign-in
    http.get("*/auth/providers", () => HttpResponse.json(providers())),
    http.get("*/auth/login/google", ({ request }) => {
      if (mode !== "direct" || !providerIds.includes("google"))
        return notFound();
      const next = new URL(request.url).searchParams.get("next") ?? "/";
      return new HttpResponse(null, {
        status: 302,
        headers: {
          location: `https://accounts.google.com/o/oauth2/v2/auth?mock=1&next=${encodeURIComponent(next)}`,
        },
      });
    }),
    http.post("*/auth/code/request", async ({ request }) => {
      if (mode !== "direct" || !providerIds.includes("email"))
        return notFound();
      const r = await c.body(request, CodeRequestSchema);
      if (r.error) return r.error;
      if (o.turnstile && !r.data.turnstileToken)
        return err("turnstile_required", "Complete the verification", {
          field: "turnstile",
          required: true,
        });
      if (o.turnstile && r.data.turnstileToken === "fail")
        return err("turnstile_failed", "Verification failed; try again");
      const email = r.data.email.toLowerCase();
      const n = (requests.get(email) ?? 0) + 1;
      requests.set(email, n);
      if (n > 5)
        return err("rate_limited", "Too many codes requested", {
          retryAfter: 3600,
          scope: "email",
        });
      pending = { email, attempts: 0, next: r.data.next ?? "/" };
      return HttpResponse.json(
        {
          maskedEmail: mask(email),
          expiresIn: CODE_POLICY.ttlSec,
          resendAfter: CODE_POLICY.resendAfterSec,
          codeLength: CODE_POLICY.length,
        },
        { status: 202 },
      );
    }),
    http.post("*/auth/code/verify", async ({ request }) => {
      const r = await c.body(request, CodeVerifySchema);
      if (r.error) return r.error;
      if (!pending)
        return err("unauthorized", "Start over", { reason: "no_pending" });
      const p = pending;
      if ((fails.get(p.email) ?? 0) >= 10)
        return err("rate_limited", "Too many attempts", {
          retryAfter: 3600,
          scope: "email",
        });
      if (normalizeCode(r.data.code) !== HOSTED_MOCK_CODE) {
        p.attempts++;
        fails.set(p.email, (fails.get(p.email) ?? 0) + 1);
        if (p.attempts >= CODE_POLICY.maxAttempts) {
          pending = null;
          return err("unauthorized", "Code expired", { reason: "expired" });
        }
        return err("unauthorized", "Wrong code", {
          reason: "invalid_code",
          attemptsLeft: CODE_POLICY.maxAttempts - p.attempts,
        });
      }
      pending = null;
      let u = members.find((m) => m.email === p.email);
      if (!u) {
        u = {
          id: newId(),
          email: p.email,
          name: null,
          role: p.email.endsWith(`@${MOCK_DOMAIN}`) ? "member" : "guest",
          lastSeenAt: null,
          status: "active",
          identities: [],
        };
        members.push(u);
        spaces.push({
          id: u.id,
          kind: "personal",
          name: u.email,
          ownerId: u.id,
          allMembersRole: null,
          publicLinks: true,
          createdAt: iso(),
        });
      }
      if (u.status !== "active")
        return err("unauthorized", "Wrong code", {
          reason: "invalid_code",
          attemptsLeft: 0,
        });
      me.user = u;
      me.auth = {
        method: "code",
        readOnly: false,
        cap: null,
        expiresAt: new Date(
          Date.now() + (u.role === "guest" ? 24 : 168) * 3600_000,
        ).toISOString(),
      };
      refresh();
      return HttpResponse.json({
        next: p.next,
        user: u,
        readOnly: me.auth.readOnly,
      });
    }),
    http.post("*/__test/otp/latest", async ({ request }) => {
      const r = await c.body(request, OtpLatestInputSchema);
      if (r.error) return r.error;
      return pending && pending.email === r.data.email.toLowerCase()
        ? HttpResponse.json({ code: HOSTED_MOCK_CODE })
        : notFound();
    }),
    // -- usage_off
    http.get("*/api/v1/usage", () =>
      features().includes("usage_off") ? notFound() : undefined,
    ),
    // -- members (status filter), departed transfer, identity reset
    http.get(
      "*/api/v1/members",
      authed(({ request }) => {
        const q = new URL(request.url).searchParams;
        const r = MembersQuerySchema.safeParse(
          q.has("status") ? { status: q.get("status") } : {},
        );
        if (!r.success)
          return err("bad_request", "Invalid query", r.error.issues);
        if (!r.data.status.every((s) => s === "active") && !isAdmin())
          return notFound();
        return HttpResponse.json(
          members.filter((m) => r.data.status.includes(m.status ?? "active")),
        );
      }),
    ),
    http.get(
      "*/api/v1/members/:id/transfer",
      authed(({ params }) => {
        const m = memberOf(params.id as string);
        if (!m || !isAdmin()) return notFound();
        return HttpResponse.json(departed.get(m.id) ?? { live: 0, deleted: 0 });
      }),
    ),
    http.post(
      "*/api/v1/members/:id/transfer",
      authed(async ({ request, params }) => {
        const m = memberOf(params.id as string);
        if (!m || !isAdmin()) return notFound();
        const r = await c.body(request, TransferInputSchema);
        if (r.error) return r.error;
        if ((m.status ?? "active") === "active")
          return err("member_active", "Suspend or remove the member first");
        const to = r.data.to;
        if (to.kind === "user") {
          const u = memberOf(to.userId);
          if (!validSuccessor(u))
            return err("invalid_successor", "Pick an active member");
        } else {
          const s = findSpace(to.spaceId);
          if (!s) return notFound();
          if (s.kind === "personal")
            return err("space_personal", "Pick a shared space");
        }
        const left = departed.get(m.id) ?? { live: 0, deleted: 0 };
        const total = left.live + left.deleted;
        const moved = Math.min(TRANSFER_PAGE, total);
        const liveMoved = Math.min(moved, left.live);
        left.live -= liveMoved;
        left.deleted -= moved - liveMoved;
        departed.set(m.id, left);
        log("artifact.transfer", { type: "user", id: m.id }, null, {
          moved,
        });
        const remaining = left.live + left.deleted;
        return HttpResponse.json({
          moved,
          remaining,
          nextCursor: remaining > 0 ? btoa(String(moved)) : null,
        });
      }),
    ),
    ...(["put", "delete"] as const).map((method) =>
      http[method](
        "*/api/v1/members/:id/restricted",
        authed(({ params }) => {
          const m = memberOf(params.id as string);
          if (!m || !isAdmin() || m.role === "owner") return notFound();
          const on = method === "put";
          if (on !== manualRestricted.has(m.id)) {
            if (on) manualRestricted.add(m.id);
            else manualRestricted.delete(m.id);
            log(on ? "restricted.set" : "restricted.remove", {
              type: "user",
              id: m.id,
            });
          }
          refresh();
          return HttpResponse.json(m);
        }),
      ),
    ),
    http.delete(
      "*/api/v1/members/:id/identities/:provider",
      authed(({ params }) => {
        const m = memberOf(params.id as string);
        if (
          !m ||
          !isAdmin() ||
          m.role === "owner" ||
          params.provider !== "google" ||
          !m.identities?.includes("google")
        )
          return notFound();
        m.identities = m.identities.filter((x) => x !== "google");
        log("identity.reset", { type: "user", id: m.id });
        return noContent();
      }),
    ),
    // -- move and transfer
    http.post(
      "*/api/v1/artifacts/:id/move",
      authed(async ({ request, params }) => {
        const a = artifacts.find(
          (x) => x.id === params.id && x.deletedAt === null,
        );
        if (!a?.can?.move) return notFound();
        const r = await c.body(request, MoveArtifactInputSchema);
        if (r.error) return r.error;
        const s = findSpace(r.data.spaceId);
        if (!s) return notFound();
        if (s.kind === "personal")
          return err(
            "space_personal",
            "Artifacts move into shared spaces only",
          );
        if (!visible(s)) return notFound();
        const role = roleIn(s);
        if (!role || role === "viewer")
          return err("space_forbidden", "You can't publish to this space");
        a.space = ref(s);
        a.access = levelIn(s) as AccessLevel;
        if (!s.publicLinks && a.visibility === "public") a.visibility = "team";
        log("artifact.move", { type: "artifact", id: a.id }, s.id);
        refresh();
        return HttpResponse.json(a);
      }),
    ),
    http.post(
      "*/api/v1/artifacts/:id/transfer",
      authed(async ({ request, params }) => {
        const a = artifacts.find(
          (x) => x.id === params.id && x.deletedAt === null,
        );
        if (!a?.can?.transfer) return notFound();
        const r = await c.body(request, TransferArtifactInputSchema);
        if (r.error) return r.error;
        const u = memberOf(r.data.userId);
        if (!validSuccessor(u) || u.id === me.user.id)
          return err("invalid_successor", "Pick an active member");
        const s = findSpace(u.id) as SpaceRow;
        a.space = ref(s);
        a.owner = { id: u.id, email: u.email, name: u.name };
        a.access = "editor";
        const list = shares[a.id] ?? [];
        shares[a.id] = list;
        if (me.user.email && !list.some((x) => x.email === me.user.email))
          list.push({ email: me.user.email, role: "editor", createdAt: iso() });
        log("artifact.transfer", { type: "artifact", id: a.id }, s.id);
        refresh();
        return HttpResponse.json(a);
      }),
    ),
    // -- spaces
    http.get(
      "*/api/v1/spaces",
      authed(({ request }) => {
        const q = new URL(request.url).searchParams;
        const kind = q.get("kind");
        const list = spaces
          .filter((s) => visible(s) && (!kind || s.kind === kind))
          .map(view)
          .sort((a, b) =>
            a.kind === b.kind
              ? a.name.localeCompare(b.name)
              : a.kind === "personal"
                ? -1
                : 1,
          );
        return page(list, q);
      }),
    ),
    http.post(
      "*/api/v1/spaces",
      authed(async ({ request }) => {
        if (!isAdmin()) return notFound();
        const r = await c.body(request, SpaceCreateSchema);
        if (r.error) return r.error;
        const s: SpaceRow = {
          id: newId(),
          kind: "shared",
          ownerId: null,
          createdAt: iso(),
          ...r.data,
        };
        spaces.push(s);
        rows.set(s.id, []);
        log("space.create", { type: "space", id: s.id }, s.id);
        refresh();
        return HttpResponse.json(view(s), { status: 201 });
      }),
    ),
    http.get(
      sp,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        return s instanceof Response ? s : HttpResponse.json(view(s));
      }),
    ),
    http.patch(
      sp,
      authed(async ({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces can't be changed");
        const r = await c.body(request, SpacePatchSchema);
        if (r.error) return r.error;
        const manager = roleIn(s) === "manager";
        const keys = Object.keys(r.data);
        const allowed = isAdmin()
          ? true
          : manager &&
            keys.every((k) =>
              (SPACE_MANAGER_FIELDS as readonly string[]).includes(k),
            );
        if (!allowed) return notFound();
        if (
          r.data.publicLinks !== undefined &&
          r.data.publicLinks !== s.publicLinks
        ) {
          log("space.public_links", { type: "space", id: s.id }, s.id, {
            publicLinks: r.data.publicLinks,
          });
          if (!r.data.publicLinks)
            for (const a of artifacts)
              if (a.space?.id === s.id && a.visibility === "public")
                a.visibility = "team";
        }
        Object.assign(s, r.data);
        log("space.update", { type: "space", id: s.id }, s.id, { keys });
        refresh();
        return HttpResponse.json(view(s));
      }),
    ),
    http.delete(
      sp,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces can't be deleted");
        if (!isAdmin()) return notFound();
        if (artifacts.some((a) => a.space?.id === s.id))
          return err("space_not_empty", "Move or delete its artifacts first");
        spaces.splice(spaces.indexOf(s), 1);
        log("space.delete", { type: "space", id: s.id }, s.id);
        return noContent();
      }),
    ),
    http.get(
      `${sp}/members`,
      authed(({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        const list = (rows.get(s.id) ?? [])
          .map((r) => memberView(r))
          .filter((x): x is SpaceMember => x !== null);
        return page(list, new URL(request.url).searchParams);
      }),
    ),
    http.post(
      `${sp}/members/self`,
      authed(async ({ request, params }) => {
        const s = findSpace(params.id);
        if (!s || !isAdmin()) return notFound();
        if (s.kind === "personal")
          return err(
            "space_personal",
            "Admins can add themselves to shared spaces only",
          );
        const r = await c.body(request, SpaceMemberPutSchema);
        if (r.error) return r.error;
        const list = rows.get(s.id) ?? [];
        rows.set(s.id, list);
        let row = list.find((x) => x.userId === me.user.id);
        if (!row) {
          row = {
            userId: me.user.id,
            manualRole: null,
            syncRole: null,
            groups: [],
          };
          list.push(row);
        }
        row.manualRole = r.data.role;
        // The server also notifies the space's managers.
        log("space.admin_self_add", { type: "user", id: me.user.id }, s.id, {
          role: r.data.role,
        });
        refresh();
        return HttpResponse.json(memberView(row), { status: 201 });
      }),
    ),
    http.put(
      `${sp}/members/:userId`,
      authed(async ({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces have no members");
        if (!isAdmin() && roleIn(s) !== "manager") return notFound();
        const u = memberOf(params.userId as string);
        if (!u) return notFound();
        const r = await c.body(request, SpaceMemberPutSchema);
        if (r.error) return r.error;
        const list = rows.get(s.id) ?? [];
        rows.set(s.id, list);
        let row = list.find((x) => x.userId === u.id);
        if (!row) {
          row = { userId: u.id, manualRole: null, syncRole: null, groups: [] };
          list.push(row);
          log("space.member.add", { type: "user", id: u.id }, s.id);
        } else log("space.member.role", { type: "user", id: u.id }, s.id);
        row.manualRole = r.data.role;
        refresh();
        return HttpResponse.json(memberView(row));
      }),
    ),
    http.delete(
      `${sp}/members/:userId`,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (!isAdmin() && roleIn(s) !== "manager") return notFound();
        const list = rows.get(s.id) ?? [];
        const row = list.find((x) => x.userId === params.userId);
        if (!row?.manualRole) return notFound();
        row.manualRole = null;
        if (!row.syncRole) list.splice(list.indexOf(row), 1);
        log("space.member.remove", { type: "user", id: row.userId }, s.id);
        refresh();
        return noContent();
      }),
    ),
    http.get(
      `${sp}/mappings`,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (!isAdmin()) return notFound();
        return HttpResponse.json(mappings.get(s.id) ?? []);
      }),
    ),
    http.put(
      `${sp}/mappings/:groupId`,
      authed(async ({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (!isAdmin()) return notFound();
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces have no mappings");
        const off = syncOff();
        if (off) return off;
        const r = await c.body(request, GroupMappingPutSchema);
        if (r.error) return r.error;
        const g = groups.find((x) => x.groupId === params.groupId);
        if (!g) return notFound();
        const list = mappings.get(s.id) ?? [];
        mappings.set(s.id, list);
        let m = list.find((x) => x.groupId === g.groupId);
        if (!m) {
          m = {
            groupId: g.groupId,
            email: g.email,
            name: g.name,
            role: r.data.role,
            memberCount: g.memberCount,
            lastSyncedAt: null,
          };
          list.push(m);
        }
        m.role = r.data.role;
        log("mapping.set", { type: "mapping", id: m.groupId }, s.id);
        return HttpResponse.json(m);
      }),
    ),
    http.delete(
      `${sp}/mappings/:groupId`,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (!isAdmin()) return notFound();
        const off = syncOff();
        if (off) return off;
        const list = mappings.get(s.id) ?? [];
        const i = list.findIndex((x) => x.groupId === params.groupId);
        if (i < 0) return notFound();
        list.splice(i, 1);
        log(
          "mapping.remove",
          { type: "mapping", id: params.groupId as string },
          s.id,
        );
        return noContent();
      }),
    ),
    // -- directory
    http.get(
      "*/api/v1/directory/restricted-groups",
      authed(() => (isAdmin() ? HttpResponse.json(restricted) : notFound())),
    ),
    http.put(
      "*/api/v1/directory/restricted-groups/:groupId",
      authed(({ params }) => {
        if (!isAdmin()) return notFound();
        const off = syncOff();
        if (off) return off;
        const d = groups.find((x) => x.groupId === params.groupId);
        if (!d) return notFound();
        let g = restricted.find((x) => x.groupId === d.groupId);
        if (!g) {
          g = {
            groupId: d.groupId,
            email: d.email,
            name: d.name,
            memberCount: d.memberCount,
            createdAt: iso(),
          };
          restricted.push(g);
          log("restricted.set", { type: "group", id: g.groupId });
        }
        refresh();
        return HttpResponse.json(g);
      }),
    ),
    http.delete(
      "*/api/v1/directory/restricted-groups/:groupId",
      authed(({ params }) => {
        if (!isAdmin()) return notFound();
        // Any mode: frozen restrictions stay in force until an admin lifts them.
        const i = restricted.findIndex((x) => x.groupId === params.groupId);
        if (i < 0) return notFound();
        restricted.splice(i, 1);
        log("restricted.remove", {
          type: "group",
          id: params.groupId as string,
        });
        refresh();
        return noContent();
      }),
    ),
    http.get(
      "*/api/v1/directory/groups",
      authed(({ request }) => {
        if (!isAdmin()) return notFound();
        const q = new URL(request.url).searchParams;
        const needle = (q.get("q") ?? "").toLowerCase();
        return page(
          groups.filter(
            (g) =>
              !needle ||
              g.email.includes(needle) ||
              g.name.toLowerCase().includes(needle),
          ),
          q,
          30,
        );
      }),
    ),
    http.get(
      "*/api/v1/directory/connect",
      authed(() =>
        me.user.role === "owner"
          ? new HttpResponse(null, {
              status: 302,
              headers: {
                location:
                  "https://accounts.google.com/o/oauth2/v2/auth?mock=directory",
              },
            })
          : notFound(),
      ),
    ),
    http.post(
      "*/api/v1/directory/sync",
      authed(() => {
        if (me.user.role !== "owner") return notFound();
        if (directoryMode !== "google")
          return err("directory_sync_off", "Directory sync is off or frozen");
        sync.nextRunAt = iso();
        return HttpResponse.json(sync, { status: 202 });
      }),
    ),
    http.post(
      "*/api/v1/directory/held/:groupId/confirm",
      authed(({ params }) => {
        if (me.user.role !== "owner") return notFound();
        const i = sync.held.findIndex((h) => h.groupId === params.groupId);
        if (i < 0) return notFound();
        sync.held.splice(i, 1);
        log("directory.sweep.confirmed", {
          type: "group",
          id: params.groupId as string,
        });
        return HttpResponse.json(sync, { status: 202 });
      }),
    ),
    http.get(
      "*/api/v1/directory",
      authed(() => (isAdmin() ? HttpResponse.json(sync) : notFound())),
    ),
    http.delete(
      "*/api/v1/directory",
      authed(() => (me.user.role === "owner" ? noContent() : notFound())),
    ),
    http.get(
      "*/api/v1/audit",
      authed(({ request }) =>
        isAdmin() ? page(audit, new URL(request.url).searchParams) : notFound(),
      ),
    ),
  ];

  return {
    handlers,
    refresh,
    publishSchema,
    checkPublish,
    placeNew,
    refuseCappedCreate,
    refusePublic,
  };
}
