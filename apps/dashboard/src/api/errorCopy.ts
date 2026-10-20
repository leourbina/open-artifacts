import type { ErrorCode } from "@oa/shared";
import { ApiClientError } from "./client";

/** The UI's own copy for the hosted error codes (Design's final strings). */
const COPY: Partial<Record<ErrorCode, string>> = {
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
  reauth_required:
    "For your security, sign in with Google again to manage the directory.",
};

/** Asking a space manager can't help a guest or restricted member. */
const CAPPED_FORBIDDEN = "Your account can only view, so you can't publish.";

/**
 * What to tell the person about `e`: the mapped copy for a hosted code, else
 * the server's message, else `fallback`. `capped` (Me.auth.cap is set) picks
 * the capped wording of `space_forbidden`.
 */
export const errorCopy = (
  e: unknown,
  fallback: string,
  ctx?: { capped?: boolean },
): string => {
  if (!(e instanceof ApiClientError)) return fallback;
  if (e.code === "space_forbidden" && ctx?.capped) return CAPPED_FORBIDDEN;
  return (e.code !== "cpu_limit" && COPY[e.code]) || e.message || fallback;
};
