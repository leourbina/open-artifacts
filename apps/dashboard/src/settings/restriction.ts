import type { Restriction } from "../api/contract";

/** "A", "A and B", "A, B and C". */
const listOf = (names: string[]) =>
  names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Why someone is restricted, as the row shows it under the email: "manually",
 * "via Contractors", "manually and via Contractors". Null when they aren't.
 */
export const restrictionReason = (
  r: Restriction | null | undefined,
): string | null => {
  if (!r) return null;
  const via = r.groups.length
    ? `via ${listOf(r.groups.map((g) => g.name ?? g.email))}`
    : null;
  if (r.manual) return via ? `manually and ${via}` : "manually";
  return via;
};

/** The full sentence ("Restricted via Contractors"), or null when not restricted. */
export const restrictionLabel = (
  r: Restriction | null | undefined,
): string | null => {
  const why = restrictionReason(r);
  return why ? `Restricted ${why}` : null;
};
