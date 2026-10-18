import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const team = process.env.STAGING_ACCESS_TEAM_DOMAIN;

describe.skipIf(!base)("staging smoke: auth", () => {
  it("GET /auth/login redirects to the Access authorize endpoint", async () => {
    const r = await fetch(`${base}/auth/login?next=/`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location") ?? "");
    if (team) expect(loc.hostname).toBe(team);
    else expect(loc.hostname).toMatch(/\.cloudflareaccess\.com$/);
    expect(loc.pathname).toMatch(
      /^\/cdn-cgi\/access\/sso\/oidc\/.+\/authorization$/,
    );
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("the login state cookie is __Host- prefixed, HttpOnly, Secure, Lax, Path=/, Max-Age=900, no Domain", async () => {
    const r = await fetch(`${base}/auth/login?next=/`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const cookies = r.headers.getSetCookie();
    const oidc = cookies.filter((c) => c.startsWith("__Host-oa_oidc_"));
    expect(oidc).toHaveLength(1);
    const [pair, ...attrs] = oidc[0].split(/;\s*/);
    expect(pair).toMatch(/^__Host-oa_oidc_[A-Za-z0-9_-]{10}=.+/);
    expect(attrs).toEqual([
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=900",
    ]);
    expect(attrs.some((a) => /^domain=/i.test(a))).toBe(false);
  });

  // __Host-oa_session is only set after a completed OIDC callback (interactive
  // Access login). /auth/dev-login exists only with ENVIRONMENT=dev and is 404
  // on staging, so the session cookie's attributes can't be asserted here.
  // Assert what is reachable: no cookie -> 401, and no session cookie is set.
  it("GET /api/v1/me without a cookie is 401 and sets no session cookie", async () => {
    const r = await fetch(`${base}/api/v1/me`, { redirect: "manual" });
    expect(r.status).toBe(401);
    expect(r.headers.getSetCookie().join("\n")).not.toContain("oa_session");
  });
});
