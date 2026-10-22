// Hosted M1 spaces, members, group mappings and the restricted-group cap (P3).
// No access is 404 (never 403), except the explicit space_forbidden on
// publish/move. Personal spaces are never targets of these routes (space_personal).
import { z } from "zod";
import { UserRefSchema } from "../schemas.js";
import {
  CapReasonSchema,
  GroupRefSchema,
  MemberStatusSchema,
  SpaceKindSchema,
  SpaceRefSchema,
  SpaceRoleSchema,
} from "./core.js";

/**
 * Space.can. manageMappings: list and change this space's group mappings.
 * True for org admins, and for the space's managers while
 * Settings.spaceManagerMappings is on. Always false for personal spaces.
 */
export const SpaceCanSchema = z.object({ manageMappings: z.boolean() });
export type SpaceCan = z.infer<typeof SpaceCanSchema>;

export const SpaceSchema = SpaceRefSchema.extend({
  /** Personal spaces only. */
  owner: UserRefSchema.nullable(),
  /** Role every non-guest, non-restricted member gets; null = none. */
  allMembersRole: SpaceRoleSchema.nullable(),
  /** Effective; own personal space = "manager"; null = org admin view only. */
  myRole: SpaceRoleSchema.nullable(),
  memberCount: z.number().int(),
  /** Live artifacts. */
  artifactCount: z.number().int(),
  createdAt: z.string(),
  /** What the caller may do in this space (optional: older servers omit it). */
  can: SpaceCanSchema.optional(),
});
export type Space = z.infer<typeof SpaceSchema>;

/** GET R.spaces query. Response: Page<Space>, by name. */
export const SpacesQuerySchema = z.strictObject({
  kind: SpaceKindSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SpacesQuery = z.infer<typeof SpacesQuerySchema>;

/** POST R.spaces (org owner, admin) -> 201 Space. */
export const SpaceCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  allMembersRole: SpaceRoleSchema.nullable().default(null),
  publicLinks: z.boolean().default(true),
});
export type SpaceCreate = z.infer<typeof SpaceCreateSchema>;
export type SpaceCreateInput = z.input<typeof SpaceCreateSchema>;

/**
 * PATCH R.space(id) -> Space. name and publicLinks: space manager or org
 * admin (publicLinks changes are audited; off rewrites the space's public
 * artifacts to team and closes their sockets). allMembersRole: org owner or
 * admin. (outsideSharing is dropped until M4.) Making an artifact public in a
 * space with publicLinks off is 403 public_links_off.
 */
export const SpacePatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    allMembersRole: SpaceRoleSchema.nullable(),
    publicLinks: z.boolean(),
  })
  .partial();
export type SpacePatch = z.infer<typeof SpacePatchSchema>;
/** Fields a space manager (not admin) may change. */
export const SPACE_MANAGER_FIELDS = ["name", "publicLinks"] as const;

export const SpaceMemberSourceSchema = z.enum(["manual", "sync"]);
export type SpaceMemberSource = z.infer<typeof SpaceMemberSourceSchema>;

/** GET R.spaceMembers(id) -> Page<SpaceMember>. Keyed by user id. */
export const SpaceMemberSchema = z.object({
  userId: z.string(),
  user: UserRefSchema,
  status: MemberStatusSchema,
  /** Effective role: max of manualRole and syncRole. */
  role: SpaceRoleSchema,
  /** Which row grants `role` (manual wins a tie). */
  source: SpaceMemberSourceSchema,
  manualRole: SpaceRoleSchema.nullable(),
  syncRole: SpaceRoleSchema.nullable(),
  /** Mapped groups that grant syncRole. */
  groups: z.array(GroupRefSchema),
  /** Guest or restricted: effective access is viewer whatever the role. */
  cap: CapReasonSchema.nullable(),
});
export type SpaceMember = z.infer<typeof SpaceMemberSchema>;

/** PUT R.spaceMember(id, userId) (space manager, org admin) -> SpaceMember. Sets the manual row. Also the body of POST R.spaceMemberSelf(id). */
export const SpaceMemberPutSchema = z.strictObject({ role: SpaceRoleSchema });
export type SpaceMemberPut = z.infer<typeof SpaceMemberPutSchema>;

/** Roles a space manager (not an org admin) may map a group to; manager is 403 space_forbidden. */
export const SPACE_MANAGER_MAPPING_ROLES = ["viewer", "editor"] as const;

/**
 * GET R.spaceMappings(id) -> GroupMapping[] (bounded). Org admin or a space
 * manager (whatever Settings.spaceManagerMappings says). Personal: 400
 * space_personal. Per-space rows only: Every-space rows are R.orgMappings.
 * Pending server implementation (P3 T9/T14).
 */
export const GroupMappingSchema = GroupRefSchema.extend({
  role: SpaceRoleSchema,
  memberCount: z.number().int().nullable(),
  lastSyncedAt: z.string().nullable(),
});
export type GroupMapping = z.infer<typeof GroupMappingSchema>;

/**
 * PUT R.spaceMapping(id, group) -> GroupMapping; DELETE -> 204. Org admin: any
 * role. Space manager: only rows that are and stay viewer|editor
 * (SPACE_MANAGER_MAPPING_ROLES). Checks in order: personal 400
 * space_personal; no role 404; PUT while Settings.spaceManagerMappings is off
 * 403 directory_mapping_off (DELETE is always allowed: removing access);
 * a manager role (PUT body, or the existing row on PUT or DELETE) 403
 * space_forbidden; sync off or frozen 409 directory_sync_off. Manager access
 * is pending server implementation (P3 T9/T14).
 */
export const GroupMappingPutSchema = z.strictObject({ role: SpaceRoleSchema });
export type GroupMappingPut = z.infer<typeof GroupMappingPutSchema>;

/*
 * "Every space" mappings reuse GroupMapping / GroupMappingPut (pending server
 * implementation, P3 T9/T14). GET R.orgMappings?cursor&limit ->
 * Page<GroupMapping> (org admin). PUT R.orgMapping(groupId) GroupMappingPut ->
 * GroupMapping (upsert); DELETE -> 204; org admin only; 409
 * directory_sync_off when sync is off or frozen; audited mapping.set /
 * mapping.remove with spaceId null. One row per group, NEVER expanded into
 * per-space rows: a member's effective role in a shared space is the
 * read-time max of the per-space rows and the org mappings of their groups
 * (SpaceMember.syncRole, groups). Applies to every shared space, including
 * ones created later, and never to a personal space.
 */

/**
 * GET R.restrictedGroups -> RestrictedGroup[] (org admin). Restricted members
 * (a restricted group, or the manual flag R.memberRestricted) are capped at
 * viewer everywhere: no allMembersRole, no create (personal space included),
 * no data writes, on REST, MCP and the data API.
 * PUT R.restrictedGroup(groupId) -> RestrictedGroup, 409 directory_sync_off
 * when sync is off or frozen; DELETE -> 204 in any mode.
 */
export const RestrictedGroupSchema = GroupRefSchema.extend({
  memberCount: z.number().int().nullable(),
  createdAt: z.string(),
});
export type RestrictedGroup = z.infer<typeof RestrictedGroupSchema>;
