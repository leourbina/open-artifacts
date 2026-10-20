import type {
  AccessLevel,
  CapReason,
  Member,
  Role,
  SpaceKind,
  SpaceRole,
  Visibility,
} from "@oa/shared";

/**
 * The hosted access policy (P3): pure functions, no I/O. authz.ts gathers a
 * DecisionInput in one D1 statement; every route and MCP tool asks `can` or
 * `orgCan`. Plan: docs/superpowers/plans/2026-10-21-hosted-m1-p3-rbac.md.
 */

/** Every per-artifact action the server checks (a superset of the contract's ArtifactAction). */
export type PolicyAction =
  | "view"
  | "versions"
  | "version.file"
  | "thumbnail.read"
  | "content.mint"
  | "data.read"
  | "events"
  | "subscribe"
  | "data.write"
  | "storage"
  | "thumbnail.write"
  | "version.text"
  | "publish"
  | "restore"
  | "upload"
  | "share"
  | "unshare"
  | "visibility"
  | "delete"
  | "undelete"
  | "data.reset"
  | "move"
  | "transfer"
  | "anonId";

export type OrgAction =
  | "space.create"
  | "space.delete"
  | "space.mappings"
  | "space.allMembers"
  | "space.members"
  | "space.rename"
  | "space.publicLinks"
  | "space.adminSelfAdd"
  | "space.publish"
  | "restricted.groups"
  | "restricted.member"
  | "artifact.create"
  | "transfer.departed"
  | "directory.manage"
  | "audit.read"
  | "members.manage"
  | "settings.manage"
  | "usage.read"
  | "tokens.create"
  | "mcp.connect";

export type DecisionInput = {
  /** Null for anonymous callers. Inactive and stale users never get here. */
  caller: { id: string; orgRole: Role } | null;
  cap: CapReason | null;
  artifact: {
    spaceId: string;
    spaceKind: SpaceKind;
    visibility: Visibility;
    deleted: boolean;
  };
  space: { publicLinks: boolean; allMembersRole: SpaceRole | null };
  /** Max of the caller's manual and sync rows in the artifact's space. */
  spaceRole: SpaceRole | null;
  shareRole: "viewer" | "editor" | null;
  allowDeleted: boolean;
};

export type CanCtx = {
  cap: CapReason | null;
  /** The artifact is in a personal space. */
  personal: boolean;
  anonymous?: boolean;
  allowAnonymousWrites?: boolean;
  /** Viewer-only first thumbnail: via a share or team access, and none stored yet. */
  firstThumbnail?: boolean;
};

/** Roles that see `team` artifacts. Guests never do. */
export const TEAM_ROLES: readonly Role[] = ["owner", "admin", "member"];

const SPACE_RANK: Record<SpaceRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

const maxRole = (
  a: SpaceRole | null,
  b: SpaceRole | null,
): SpaceRole | null => {
  if (!a) return b;
  if (!b) return a;
  return SPACE_RANK[b] > SPACE_RANK[a] ? b : a;
};

/**
 * The caller's cap: restricted (manual flag or a restricted group) or a guest
 * while P2's authConfig.guestsReadOnly is on. Null when uncapped.
 */
export function capOf(
  m: Pick<Member, "role"> & {
    restrictedManual: boolean;
    restrictedSync: boolean;
  },
  authConfig: { guestsReadOnly: boolean },
): CapReason | null {
  if (m.restrictedManual || m.restrictedSync) return "restricted";
  if (m.role === "guest" && authConfig.guestsReadOnly) return "guest";
  return null;
}

/** The decision table, first match wins, then the cap lowers the level to viewer. */
export function decide(i: DecisionInput): AccessLevel | null {
  const level = uncapped(i);
  return level && i.cap ? "viewer" : level;
}

function uncapped(i: DecisionInput): AccessLevel | null {
  const { caller, artifact: a } = i;
  const personal = a.spaceKind === "personal";
  const ownPersonal = personal && caller !== null && a.spaceId === caller.id;
  const allMembers =
    caller && caller.orgRole !== "guest" && !i.cap
      ? i.space.allMembersRole
      : null;
  const spaceRole =
    personal || !caller ? null : maxRole(i.spaceRole, allMembers);
  if (a.deleted) {
    if (!i.allowDeleted) return null;
    if (ownPersonal) return "owner";
    if (spaceRole === "manager") return "manager";
    return null;
  }
  if (ownPersonal) return "owner";
  if (spaceRole === "manager") return "manager";
  const best = maxRole(spaceRole, caller ? i.shareRole : null);
  if (best === "editor") return "editor";
  if (best === "viewer") return "viewer";
  if (a.visibility === "team" && caller && caller.orgRole !== "guest")
    return "viewer";
  if (a.visibility === "public" && (personal || i.space.publicLinks))
    return "viewer";
  return null;
}

const READ: ReadonlySet<PolicyAction> = new Set<PolicyAction>([
  "view",
  "versions",
  "version.file",
  "thumbnail.read",
  "content.mint",
  "data.read",
  "events",
  "subscribe",
]);
const EDIT: ReadonlySet<PolicyAction> = new Set<PolicyAction>([
  "version.text",
  "publish",
  "restore",
  "upload",
]);
const FULL: ReadonlySet<PolicyAction> = new Set<PolicyAction>([
  "share",
  "unshare",
  "visibility",
  "delete",
  "undelete",
  "data.reset",
  "move",
]);

/**
 * Whether `level` may take `action`. Manager and owner allow the same actions
 * except `transfer` (personal owner only). A capped caller keeps reads only.
 * Never compare levels by rank for owner actions; ask `can`.
 */
export function can(
  level: AccessLevel | null,
  action: PolicyAction,
  ctx: CanCtx,
): boolean {
  if (!level) return false;
  const capped = ctx.cap != null;
  const full = !capped && (level === "manager" || level === "owner");
  if (READ.has(action)) return true;
  switch (action) {
    case "anonId":
      return ctx.anonymous === true && ctx.allowAnonymousWrites === true;
    case "data.write":
      if (capped) return false;
      return ctx.anonymous ? ctx.allowAnonymousWrites === true : true;
    case "storage":
      return !capped && !ctx.anonymous;
    case "thumbnail.write":
      if (capped || ctx.anonymous) return false;
      return level === "viewer" ? ctx.firstThumbnail === true : true;
    case "transfer":
      return full && level === "owner" && ctx.personal;
  }
  if (EDIT.has(action)) return !capped && level !== "viewer";
  if (FULL.has(action)) return full;
  return false;
}

const ORG_ADMINS: readonly Role[] = ["owner", "admin"];

/** Instance and space administration (no artifact involved). */
export function orgCan(
  m: Member,
  action: OrgAction,
  opts: { spaceRole?: SpaceRole | null; cap?: CapReason | null } = {},
): boolean {
  const admin = ORG_ADMINS.includes(m.role);
  const capped = opts.cap != null;
  switch (action) {
    case "space.members":
    case "space.rename":
    case "space.publicLinks":
      return admin || opts.spaceRole === "manager";
    case "space.publish":
      return (
        !capped &&
        m.role !== "guest" &&
        (opts.spaceRole === "editor" || opts.spaceRole === "manager")
      );
    case "artifact.create":
      return !capped;
    case "directory.manage":
      return m.role === "owner";
    case "tokens.create":
    case "mcp.connect":
      return m.role !== "guest" && !capped;
    default:
      return admin;
  }
}

/**
 * Whether an events-socket subscriber sees publisher names: team members,
 * and anyone whose access is more than a public link.
 */
export function namedEvents(
  caller: Pick<Member, "role"> | null,
  level: AccessLevel,
  visibility: Visibility,
): boolean {
  if (!caller) return false;
  return (
    TEAM_ROLES.includes(caller.role) ||
    level !== "viewer" ||
    visibility !== "public"
  );
}
