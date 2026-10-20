import { z } from "zod";

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "csrf",
  "not_found",
  "conflict",
  "too_large",
  "rate_limited",
  "quota_exceeded",
  "capability_denied",
  "internal",
  // Hosted M1 (packages/shared/HOSTED_CONTRACT.md).
  "space_forbidden",
  "space_personal",
  "space_not_empty",
  "public_links_off",
  "use_move",
  "invalid_successor",
  "member_active",
  "directory_sync_off",
  "turnstile_failed",
  "turnstile_required",
  "reauth_required",
  "restrict_admin",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const STATUS_FOR: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  csrf: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
  quota_exceeded: 503,
  capability_denied: 403,
  internal: 500,
  /** Publish or move into a space the caller may not publish to (also capped callers creating). */
  space_forbidden: 403,
  /** A personal space as a move or bulk-transfer target, or as a spaces-route target. */
  space_personal: 400,
  /** DELETE a space that still holds artifacts (trash included). */
  space_not_empty: 409,
  /** Make an artifact public (publish or PATCH visibility) in a space whose publicLinks is off. */
  public_links_off: 403,
  /** PublishInput.spaceId given with the id of an existing artifact: use R.moveArtifact. */
  use_move: 400,
  /** Transfer successor is not an active, non-guest, non-restricted member. */
  invalid_successor: 400,
  /** Departed-person transfer on a member who is still active. */
  member_active: 409,
  /** Group mapping or restricted-group change while directory sync is off or frozen. */
  directory_sync_off: 409,
  /** POST AUTH.codeRequest with a missing or rejected Turnstile token. */
  turnstile_failed: 403,
  /** POST AUTH.codeRequest without a token while Turnstile is configured; details { field: "turnstile", required: true }. */
  turnstile_required: 400,
  /** Break-glass directory routes: the stale org owner needs a fresh Google sign-in (10 min). */
  reauth_required: 401,
  /** PUT R.memberRestricted(id) on an org owner or admin: they can't be restricted. */
  restrict_admin: 400,
};

export const QUOTA_MESSAGE =
  "Daily free-plan limit reached; resets at 00:00 UTC";
