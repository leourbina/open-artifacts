// Verified-domain lists (AUTH_DOMAINS) and the exact tenant check used by
// every sign-in path. Shared by the server and the auth broker.

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const MAX_LEN = 253;

function isDomain(d: string): boolean {
  if (d.length > MAX_LEN) return false;
  const labels = d.split(".");
  if (labels.length < 2) return false;
  const tld = labels.pop() as string;
  return TLD.test(tld) && labels.every((l) => LABEL.test(l));
}

/**
 * A comma list of domains: trimmed, lowercased, deduped, in input order.
 * Entries that aren't plain DNS names (IDNA A-labels allowed) go to `invalid`
 * as written; blank entries are skipped.
 */
export function parseDomains(raw: string): {
  domains: string[];
  invalid: string[];
} {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const d = entry.toLowerCase();
    if (!isDomain(d)) invalid.push(entry);
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, invalid };
}

/**
 * Exact membership. `d` is compared as given (no lowercasing or trimming), so
 * a claim like "A.com" or "a.com." is a mismatch, never folded onto a match.
 */
export function inDomains(domains: readonly string[], d: unknown): boolean {
  return typeof d === "string" && domains.includes(d);
}
