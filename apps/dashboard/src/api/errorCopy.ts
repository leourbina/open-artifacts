import type { ErrorCode } from "@oa/shared";
import { ApiClientError } from "./client";

/** P2 T7 adds it to ERROR_CODES; keyed by string until then. */
type CopyCode = ErrorCode | "code_unavailable";

/** The UI's own copy for the hosted error codes (Design's final strings, 2026-10-21). */
const COPY: Partial<Record<CopyCode, string>> = {
  space_forbidden:
    "You can't publish to this space. Ask a space manager to make you an editor.",
  space_personal: "Personal spaces can't be used here. Pick a shared space.",
  space_not_empty:
    "This space still has artifacts. Move or delete them first. Artifacts in the trash count too.",
  public_links_off:
    "Public links are off for this space. A space manager can turn them on.",
  use_move: "This artifact already exists. Use Move to change its space.",
  invalid_successor: "Pick an active member who isn't a guest or restricted.",
  member_active:
    "This person is active again, so their artifacts stay with them. Nothing was moved.",
  directory_sync_off:
    "Directory sync is off, so this isn't available right now.",
  turnstile_required: "Finish the check above, then send the code again.",
  turnstile_failed: "The check didn't go through. Try it again.",
  restrict_admin:
    "Owners and admins can't be restricted. Make them a member first.",
  code_unavailable:
    "Sign-in by email code isn't available right now. Ask your admin for help.",
  reauth_required:
    "For your security, sign in with Google again to manage the directory.",
};

/** Asking a space manager can't help a guest or restricted member. */
const CAPPED_FORBIDDEN = "Your account can only view, so you can't publish.";
/** With Google sign-in on, point at it. */
const CODE_UNAVAILABLE_GOOGLE =
  "Sign-in by email code isn't available right now. Use Continue with Google, or ask your admin.";

export const DIRECTORY_SETTINGS = "/settings/directory";

/** What the UI knows about where and who the error reached. */
export type ErrorContext = {
  /** Me.auth.cap is set (a guest or restricted member). */
  capped?: boolean;
  /** The error shows on the Directory page itself. */
  onDirectoryPage?: boolean;
  /** Google sign-in is on (AUTH.providers lists google). */
  googleOn?: boolean;
};

/**
 * What to tell the person about `e`: the mapped copy for a hosted code, else
 * the server's message, else `fallback`. `capped` picks the capped wording of
 * `space_forbidden`; `googleOn` the Google wording of `code_unavailable`.
 */
export const errorCopy = (
  e: unknown,
  fallback: string,
  ctx?: ErrorContext,
): string => {
  if (!(e instanceof ApiClientError)) return fallback;
  const code = e.code as CopyCode | "cpu_limit";
  if (code === "space_forbidden" && ctx?.capped) return CAPPED_FORBIDDEN;
  if (code === "code_unavailable" && ctx?.googleOn)
    return CODE_UNAVAILABLE_GOOGLE;
  return (code !== "cpu_limit" && COPY[code]) || e.message || fallback;
};

/** A link to show with the copy: off the Directory page, `directory_sync_off` points there. */
export const errorLink = (
  e: unknown,
  ctx?: ErrorContext,
): { label: string; to: string } | null =>
  e instanceof ApiClientError &&
  e.code === "directory_sync_off" &&
  !ctx?.onDirectoryPage
    ? { label: "Open directory settings", to: DIRECTORY_SETTINGS }
    : null;
