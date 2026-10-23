// Guards xt:live runs before any secret is read or any request is sent: it
// only ever targets two staging installs with test hooks on, never prod.

/**
 * The only hosted staging zones. The WHOLE hostname must be exactly one
 * label under one of them (a suffix match on a label boundary), so
 * stg-a.evil.com, open-artifacts-staging.app.evil.com and
 * xopen-artifacts-staging.app are all refused.
 */
export const STAGING_SUFFIXES = [
  "open-artifacts-staging.app",
  "open-artifacts-staging.page",
] as const;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The normalized origin, or throws unless it is an https staging origin. */
export function stagingOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("xt:live origin is not a URL");
  }
  const host = u.hostname.toLowerCase();
  const onStaging = STAGING_SUFFIXES.some((sfx) => {
    if (!host.endsWith(`.${sfx}`)) return false;
    return LABEL.test(host.slice(0, -sfx.length - 1));
  });
  const ok =
    u.protocol === "https:" &&
    !u.port &&
    !u.username &&
    !u.password &&
    (u.pathname === "/" || u.pathname === "") &&
    !u.search &&
    !u.hash &&
    onStaging;
  if (!ok)
    throw new Error(
      `xt:live refuses ${u.host}: not an https origin on the staging allowlist (*.open-artifacts-staging.app, *.open-artifacts-staging.page)`,
    );
  return u.origin;
}

/** Parses JSON text without throwing a body-bearing error. */
export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what}: body is not JSON`);
  }
}

function health(text: string, who: string): { installId: string } {
  const v = parseJson(text, `${who} /healthz`);
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(`${who} /healthz: not a JSON object`);
  const o = v as Record<string, unknown>;
  if (o.testHooks !== true)
    throw new Error(`${who} /healthz: testHooks is not true`);
  if (typeof o.installId !== "string" || !o.installId)
    throw new Error(`${who} /healthz: no installId`);
  return { installId: o.installId };
}

/** Both installs run test hooks and are distinct installs. */
export function checkHealth(textA: string, textB: string): void {
  const a = health(textA, "A");
  const b = health(textB, "B");
  if (a.installId === b.installId)
    throw new Error("A and B must be distinct installs (same installId)");
}
