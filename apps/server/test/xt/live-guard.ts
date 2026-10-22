// Guards xt:live runs before any secret is read or any request is sent: it
// only ever targets two staging installs with test hooks on, never prod.

/** First DNS label of an allowed host: stg-*, rl-*, staging, staging-*. */
const STAGING_LABEL = /^(stg|rl)-[a-z0-9-]+$|^staging(-[a-z0-9-]+)?$/;
/** Any label that reads as production refuses the host outright. */
const PROD_LABEL = /(^|-)(prod|production|live)(-|$)/;

/** The normalized origin, or throws unless it is an https staging origin. */
export function stagingOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("xt:live origin is not a URL");
  }
  const labels = u.hostname.toLowerCase().split(".");
  const ok =
    u.protocol === "https:" &&
    !u.port &&
    !u.username &&
    !u.password &&
    (u.pathname === "/" || u.pathname === "") &&
    !u.search &&
    !u.hash &&
    labels.length >= 3 &&
    STAGING_LABEL.test(labels[0] as string) &&
    !labels.some((l) => PROD_LABEL.test(l));
  if (!ok)
    throw new Error(
      `xt:live refuses ${u.host}: not an https origin on the staging allowlist (stg-*, rl-*, staging*)`,
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
