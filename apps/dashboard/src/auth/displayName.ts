import { ApiClientError } from "../api/client";

/** Counted in code points after trimming, as the server does. */
export const NAME_MAX = 80;
export const TOO_LONG = `Name must be at most ${NAME_MAX} characters`;

export const nameLength = (trimmed: string) => [...trimmed].length;
export const nameOk = (trimmed: string) =>
  nameLength(trimmed) >= 1 && nameLength(trimmed) <= NAME_MAX;

/** Why the server rejected a name: its first validation issue on a 400, else its message. */
export function saveError(e: unknown): string {
  if (!(e instanceof ApiClientError))
    return "Couldn't save your name. Try again.";
  const issue = Array.isArray(e.details) ? e.details[0] : undefined;
  const reason = (issue as { message?: unknown } | undefined)?.message;
  return e.status === 400 && typeof reason === "string" && reason
    ? reason
    : e.message;
}
