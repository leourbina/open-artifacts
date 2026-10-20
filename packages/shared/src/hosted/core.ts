// Hosted M1 building blocks used by the core schemas (Me, Member,
// ArtifactSummary). Imports only zod, so schemas.ts can depend on it without
// a cycle. Index: packages/shared/HOSTED_CONTRACT.md.
import { z } from "zod";

/** A role in a space. Space managers get AccessLevel "manager" on its artifacts. */
export const SpaceRoleSchema = z.enum(["viewer", "editor", "manager"]);
export type SpaceRole = z.infer<typeof SpaceRoleSchema>;

/** Every artifact belongs to one space; each user has one personal space (id = user id). */
export const SpaceKindSchema = z.enum(["personal", "shared"]);
export type SpaceKind = z.infer<typeof SpaceKindSchema>;

/** The space an artifact lives in, as summaries and Me carry it. */
export const SpaceRefSchema = z.object({
  id: z.string(),
  kind: SpaceKindSchema,
  /** Personal: the owner's effective name. */
  name: z.string(),
  /** Public links allowed in this space (always true for personal spaces). */
  publicLinks: z.boolean(),
});
export type SpaceRef = z.infer<typeof SpaceRefSchema>;

/** Me.spaces item: a shared space the caller has a role in. */
export const MySpaceSchema = SpaceRefSchema.extend({ myRole: SpaceRoleSchema });
export type MySpace = z.infer<typeof MySpaceSchema>;

export const MemberStatusSchema = z.enum(["active", "suspended", "removed"]);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

/** Linked sign-in identities (Member.identities); admins may reset "google". */
export const IdentityProviderSchema = z.enum(["google"]);
export type IdentityProvider = z.infer<typeof IdentityProviderSchema>;

/** Why a user's access is capped below their roles: guest, or a restricted group. */
export const CapReasonSchema = z.enum(["guest", "restricted"]);
export type CapReason = z.infer<typeof CapReasonSchema>;

/** Hosted billing tier (the UI's tier copy). Null when self-hosted. */
export const TierSchema = z.enum(["trial", "team", "business"]);
export type Tier = z.infer<typeof TierSchema>;

/** Directory binding mode: off (none), google (syncing), frozen (Team: kept, edited by hand). */
export const DirectoryModeSchema = z.enum(["off", "google", "frozen"]);
export type DirectoryMode = z.infer<typeof DirectoryModeSchema>;

/**
 * FEATURES env flags (comma list, set per tier by provisioning; self-hosted
 * default empty = today's behaviour). Me.instance.features lists those on.
 * spaces: spaces and roles; sync_google: directory sync running;
 * sync_frozen: Team after trial, synced rows kept and edited by hand;
 * guests_read_only: guests capped at viewer; content_revocation: content URLs
 * check user status and space publicLinks; usage_off: hosted, the Usage page
 * and R.usage are 404.
 */
export const FEATURE_FLAGS = [
  "spaces",
  "sync_google",
  "sync_frozen",
  "guests_read_only",
  "content_revocation",
  "usage_off",
] as const;
export const FeatureFlagSchema = z.enum(FEATURE_FLAGS);
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;
export const FeaturesSchema = z.array(FeatureFlagSchema);
export type Features = z.infer<typeof FeaturesSchema>;
/** Parse a FEATURES env value; unknown entries are dropped. */
export const parseFeatures = (raw: string | undefined): FeatureFlag[] => [
  ...new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is FeatureFlag =>
        (FEATURE_FLAGS as readonly string[]).includes(s),
      ),
  ),
];

/** Me.instance.directory: the binding mode plus health for the banner. */
export const InstanceDirectorySchema = z.object({
  mode: DirectoryModeSchema,
  /** Null when mode is off. */
  healthy: z.boolean().nullable(),
  /** First failure of the current outage (ISO), else null. */
  unhealthySince: z.string().nullable(),
  /** Show the "sync unhealthy" banner: unhealthy for 1 h or more. Org owner and admins only (false for others). */
  banner: z.boolean(),
  /** True while sync is unhealthy: agent PATs and MCP grants aren't capped at 24 h, so they aren't re-verified ("agent tokens not re-verified", owners). */
  tokensUnverified: z.boolean(),
});
export type InstanceDirectory = z.infer<typeof InstanceDirectorySchema>;

export const SignInModeSchema = z.enum(["access", "direct"]);
export type SignInMode = z.infer<typeof SignInModeSchema>;
export const SignInProviderIdSchema = z.enum(["access", "google", "email"]);
export type SignInProviderId = z.infer<typeof SignInProviderIdSchema>;

export const InstanceSignInSchema = z.object({
  mode: SignInModeSchema,
  providers: z.array(SignInProviderIdSchema),
});
export type InstanceSignIn = z.infer<typeof InstanceSignInSchema>;

/** How the current request was authenticated. */
export const AuthMethodSchema = z.enum([
  "access",
  "google",
  "code",
  "pat",
  "oauth",
  "dev",
  "test",
]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

export const MeAuthSchema = z.object({
  method: AuthMethodSchema,
  /** Guest under GUEST_ACCESS=read, or a restricted-group member: hide publish, edit, share and data writes. */
  readOnly: z.boolean(),
  /** Why readOnly, or null. */
  cap: CapReasonSchema.nullable(),
  /** Session expiry (ISO); null for PATs and OAuth bearers. */
  expiresAt: z.string().nullable(),
});
export type MeAuth = z.infer<typeof MeAuthSchema>;

/** Actions the caller may take on one artifact (ArtifactSummary.can). */
export const ARTIFACT_ACTIONS = [
  "edit",
  "share",
  "setVisibility",
  "delete",
  "transfer",
  "move",
  "dataWrite",
] as const;
export type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];
export const ArtifactCanSchema = z.object({
  /** Publish a version, restore, upload, patch title/description. */
  edit: z.boolean(),
  share: z.boolean(),
  setVisibility: z.boolean(),
  /** Delete and undelete. */
  delete: z.boolean(),
  /** Hand a personal artifact to another person (personal owner only). */
  transfer: z.boolean(),
  /** Move into a shared space. */
  move: z.boolean(),
  /** Live-data and storage writes, role-wise (the artifact still needs the capability). False for guests and restricted members; ordinary viewers keep it. */
  dataWrite: z.boolean(),
});
export type ArtifactCan = z.infer<typeof ArtifactCanSchema>;

export type HostedAccessLevel = "viewer" | "editor" | "manager" | "owner";

/**
 * The action table (P3 "Actions per level") as one pure function, shared by
 * the server and the mocks. `personal`: the artifact is in a personal space.
 * `cap`: the caller's cap; a capped caller gets viewer actions minus data writes.
 */
export function artifactCan(
  level: HostedAccessLevel,
  opts: { personal: boolean; cap?: CapReason | null },
): ArtifactCan {
  const capped = opts.cap != null;
  const write = !capped && level !== "viewer";
  const full = !capped && (level === "manager" || level === "owner");
  return {
    edit: write,
    share: full,
    setVisibility: full,
    delete: full,
    transfer: full && level === "owner" && opts.personal,
    move: full,
    dataWrite: !capped,
  };
}
