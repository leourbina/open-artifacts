// Shared by every generated skill (skill.md; upgrade.md and migrate.md reuse
// it): the instance-derived skill name, plus the secrets API from @oa/shared
// (re-exported under the same names). Plain Node-loadable.
import { hostSlug } from "@oa/shared";

export {
  BANG_RULE,
  DEFAULT_INSTALL_NAME,
  hostSlug,
  SECRET_ENV_VARS,
  SECRET_LABELS,
  type SecretKind,
  secretFile,
  secretRules,
  secretSnippet,
} from "@oa/shared";

/** Agent Skills `name` limit (agentskills.io/specification). */
export const SKILL_NAME_MAX = 64;

const hex6 = async (s: string): Promise<string> => {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s.toLowerCase()),
  );
  return [...new Uint8Array(d).slice(0, 3)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * The skill name for an instance: `open-artifacts-<host slug><suffix>`, e.g.
 * suffix "-upgrade". Over 64 characters, the slug part is cut and gets
 * `-<6 hex of sha256(host)>` before the suffix, so the whole stays ≤64 and
 * matches ^[a-z0-9]+(-[a-z0-9]+)*$.
 */
export async function skillName(host: string, suffix = ""): Promise<string> {
  const base = `open-artifacts-${hostSlug(host)}`;
  if (base.length + suffix.length <= SKILL_NAME_MAX) return base + suffix;
  const hash = `-${await hex6(host)}`;
  const keep = SKILL_NAME_MAX - suffix.length - hash.length;
  return base.slice(0, keep).replace(/-+$/, "") + hash + suffix;
}

/** localhost, *.localhost, 127.0.0.1 and [::1], with or without a port. */
export const isLocalHost = (host: string): boolean => {
  const h = host
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "127.0.0.1" ||
    h === "::1"
  );
};

/**
 * The origin a generated skill names: https on APP_HOST, except http for a
 * local host, whatever ENVIRONMENT says. A skill rendered by a dev Worker
 * never hands out http:// for a real host.
 */
export const skillOrigin = (host: string): string =>
  `${isLocalHost(host) ? "http" : "https"}://${host}`;
