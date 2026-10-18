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
});
