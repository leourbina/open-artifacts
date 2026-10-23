// Hosted M1 artifact additions (P3): space-aware list/search/publish, move,
// transfer, departed-person bulk transfer, member status filter.
//
// The list and search scopes are folded into ListQuerySchema and
// SearchQuerySchema (P3 T4). The publish extension is still separate here:
// PublishInputSchema also defines the MCP tool input and the generated skill,
// so P3 folds it in (and regenerates the skill) in the PR that implements it.
import { z } from "zod";
import { PublishInputSchema } from "../schemas.js";
import { MemberStatusSchema } from "./core.js";

/** The field PublishInput gains: create only; default the caller's personal space. */
export const PublishSpaceFieldSchema = z.strictObject({
  spaceId: z.string().optional(),
});
/**
 * POST R.artifacts with spaces on. spaceId is valid only when creating: with
 * the id of an existing artifact it is 400 use_move. A space the caller can't
 * publish to is 403 space_forbidden; so is any create by a capped caller.
 */
export const HostedPublishInputSchema = z
  .looseObject({ spaceId: z.string().optional() })
  .transform((v, ctx) => {
    const { spaceId, ...rest } = v;
    const r = PublishInputSchema.safeParse(rest);
    if (!r.success) {
      for (const i of r.error.issues) ctx.addIssue({ ...i, code: "custom" });
      return z.NEVER;
    }
    return { ...r.data, ...(spaceId === undefined ? {} : { spaceId }) };
  });
export type HostedPublishInput = z.infer<typeof HostedPublishInputSchema>;

/**
 * POST R.moveArtifact(id) -> ArtifactSummary. A public artifact moved into a
 * space with publicLinks off becomes "team" in the same batch and its
 * anonymous sockets close (as the publicLinks toggle-off).
 * Shared spaces only: a personal
 * target is 400 space_personal. Needs manager or owner on the artifact (404
 * otherwise) and editor or manager in the target (403 space_forbidden).
 */
export const MoveArtifactInputSchema = z.strictObject({ spaceId: z.string() });
export type MoveArtifactInput = z.infer<typeof MoveArtifactInputSchema>;

/**
 * POST R.transferArtifact(id) -> ArtifactSummary. Personal artifacts, owner
 * level only (404 otherwise); single transfer requires level === "owner"
 * (a space manager can't). The successor must be an active, non-guest,
 * non-restricted member (400 invalid_successor). Moves it to their personal space and leaves
 * the former owner an editor share.
 */
export const TransferArtifactInputSchema = z.strictObject({
  userId: z.string(),
});
export type TransferArtifactInput = z.infer<typeof TransferArtifactInputSchema>;

/** GET R.memberTransfer(id) (org owner, admin): counts only, admins never see titles. */
export const TransferSummarySchema = z.object({
  live: z.number().int(),
  deleted: z.number().int(),
});
export type TransferSummary = z.infer<typeof TransferSummarySchema>;

/**
 * POST R.memberTransfer(id) -> TransferResult; 409 member_active when the
 * member is active. Target user: active, non-guest, non-restricted (400 invalid_successor);
 * target space: shared (400 space_personal). Pages: call again with
 * cursor = nextCursor until it is null.
 */
export const TransferInputSchema = z.strictObject({
  to: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), userId: z.string() }),
    z.strictObject({ kind: z.literal("space"), spaceId: z.string() }),
  ]),
  cursor: z.string().optional(),
});
export type TransferInput = z.infer<typeof TransferInputSchema>;

export const TransferResultSchema = z.object({
  /** At most TRANSFER_PAGE per call. */
  moved: z.number().int(),
  remaining: z.number().int(),
  nextCursor: z.string().nullable(),
});
export type TransferResult = z.infer<typeof TransferResultSchema>;
export const TRANSFER_PAGE = 100;

/** GET R.members?status=suspended,removed (comma list; default active) -> Member[]. */
export const MembersQuerySchema = z.strictObject({
  status: z
    .string()
    .default("active")
    .transform((s, ctx) => {
      const out = [] as z.infer<typeof MemberStatusSchema>[];
      for (const p of s.split(",").map((x) => x.trim())) {
        const r = MemberStatusSchema.safeParse(p);
        if (!r.success) {
          ctx.addIssue({ code: "custom", message: `Unknown status "${p}"` });
          return z.NEVER;
        }
        if (!out.includes(r.data)) out.push(r.data);
      }
      return out;
    }),
});
export type MembersQuery = z.infer<typeof MembersQuerySchema>;
