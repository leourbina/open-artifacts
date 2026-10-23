import { env } from "cloudflare:workers";
import { AUTH } from "@oa/shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { seedUser, uniq } from "./auth-helpers.js";

// P3 Task 8: an Access sign-in writes auth.signin. A fake Access (token and
// JWKS behind a fetch spy) answers the OIDC exchange.
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const ISSUER = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID}`;
afterEach(() => vi.restoreAllMocks());

async function fakeAccess(email: string, nonce: string) {
  const kp = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "a1", alg: "RS256" };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
    if (req.url === `${ISSUER}/token` && req.method === "POST") {
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        iss: ISSUER,
        aud: env.ACCESS_CLIENT_ID,
        sub: `access-${email}`,
        email,
        nonce,
        iat: now,
        exp: now + 600,
      })
        .setProtectedHeader({ alg: "RS256", kid: "a1" })
        .sign(kp.privateKey);
      return Response.json({ id_token: idToken, token_type: "Bearer" });
    }
    return realFetch(input, init);
  });
}

it("an Access sign-in is audited as auth.signin (provider access)", async () => {
  const email = uniq("accessaudit");
  const id = await seedUser(email, "member");
  const start = await app.fetch(
    new Request(`http://app.localhost${AUTH.login}?next=/`),
    env,
    ctx,
  );
  const u = new URL(start.headers.get("location") ?? "");
  expect(u.origin + u.pathname).toBe(`${ISSUER}/authorization`);
  const cookie =
    start.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  await fakeAccess(email, u.searchParams.get("nonce") ?? "");
  const r = await app.fetch(
    new Request(
      `http://app.localhost${AUTH.callback}?state=${u.searchParams.get("state")}&code=c1`,
      { headers: { cookie } },
    ),
    env,
    ctx,
  );
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/");
  const rows = (
    await env.DB.prepare(
      "select action, actor_id, detail from audit_events where target_id = ?",
    )
      .bind(id)
      .all<{ action: string; actor_id: string; detail: string }>()
  ).results;
  expect(rows).toEqual([
    {
      action: "auth.signin",
      actor_id: id,
      detail: JSON.stringify({ provider: "access" }),
    },
  ]);
});
