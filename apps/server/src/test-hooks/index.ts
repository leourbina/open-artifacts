import {
  type OAuthClientHookResult,
  OtpLatestInputSchema,
  TEST_HOOKS,
  TEST_HOOKS_ALLOWED,
  TestSessionInputSchema,
} from "@oa/shared";
import type { Context } from "hono";
import { emailKey } from "../auth/codes.js";
import { authConfig } from "../auth/config.js";
import { signSession } from "../auth/session.js";
import { normEmail } from "../db/email.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin, toErrorResponse } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import { type GrantProps, oauthProvider } from "../mcp/oauth.js";
import { oauthApi } from "../mcp/oauth-api.js";
import { mcpResource } from "../mcp/server.js";
import type { AppType } from "../routes/index.js";
import { getUserWithEpoch, upsertWithRole } from "../services/users.js";
import { b64urlEncode } from "../util/crypto.js";

// /__test/* (P2 T14): hooks P5's cross-tenant suite uses against stg-a and
// stg-b. On only when the build allows it (TEST_HOOKS_ALLOWED, a bundler
// define release builds never set) AND TEST_HOOKS=1 AND a 32+ char
// TEST_HOOK_KEY. Everything else, a wrong key included, is the standard 404,
// decided before any D1 or KV access.

const MIN_KEY = 32;
const OTP_TTL_S = 600;

export function testHooksOn(
  env: Pick<Env, "TEST_HOOKS" | "TEST_HOOK_KEY">,
): boolean {
  return (
    TEST_HOOKS_ALLOWED &&
    env.TEST_HOOKS === "1" &&
    typeof env.TEST_HOOK_KEY === "string" &&
    env.TEST_HOOK_KEY.length >= MIN_KEY
  );
}

/** KV key of the plaintext OTP copy: never the address itself. */
export const otpKvKey = (installKey: string, ek: string) =>
  `test:otp:${installKey}:${ek}`;

/** While hooks are on only: a plaintext copy of the code P5 can read back. */
export async function recordTestOtp(env: Env, ek: string, code: string) {
  if (!testHooksOn(env)) return;
  await env.OAUTH_KV.put(otpKvKey(authConfig(env).installKey, ek), code, {
    expirationTtl: OTP_TTL_S,
  });
}

/** Drops the plaintext copy once the code is used. */
export async function forgetTestOtp(env: Env, ek: string) {
  if (!testHooksOn(env)) return;
  await env.OAUTH_KV.delete(otpKvKey(authConfig(env).installKey, ek));
}

const enc = new TextEncoder();
async function sameKey(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= (u[i] as number) ^ (v[i] as number);
  return d === 0;
}

const notFound = () => toErrorResponse(new ApiError("not_found", "Not found"));
const log = (evt: string) =>
  console.log(JSON.stringify({ evt: `test_hook.${evt}` }));
const BEARER = /^\s*Bearer\s+(\S+)\s*$/i;

/** Gate: on, authorized, under RL_ANON. Null means "answer 404". */
async function admitted(c: Context<AppEnv>): Promise<boolean> {
  if (!testHooksOn(c.env)) return false;
  const given = BEARER.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  if (!(await sameKey(given, c.env.TEST_HOOK_KEY as string))) {
    log("denied");
    return false;
  }
  const rl = c.env.RL_ANON;
  if (rl) {
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const key = `test:${authConfig(c.env).installKey}:${ip}`;
    if (!(await rl.limit({ key })).success) {
      log("denied");
      return false;
    }
  }
  return true;
}

/** P3 owns space roles; until it lands, a session hook asking for them is refused. */
async function applyTestSpaceRoles(
  _env: Env,
  _userId: string,
  spaces: { spaceId: string; role: string }[],
): Promise<void> {
  if (spaces.length) throw new ApiError("bad_request", "Spaces arrive with P3");
}

// A loopback redirect: the grant is completed server-side, nothing follows it.
const HOOK_REDIRECT = "http://127.0.0.1/p5-oauth-callback";

/** A registered client and an access token for a test member, via the real provider. */
async function oauthClientFor(
  c: Context<AppEnv>,
): Promise<OAuthClientHookResult> {
  const env = c.env;
  const origin = appOrigin(env);
  const user = await upsertWithRole(env, `p5-oauth@${env.APP_HOST}`, "member");
  const helpers = oauthApi(env);
  const client = await helpers.createClient({
    redirectUris: [HOOK_REDIRECT],
    tokenEndpointAuthMethod: "none",
    clientName: "P5 test hook",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64urlEncode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const resource = mcpResource(env);
  const props: GrantProps = { userId: user.id, clientName: "P5 test hook" };
  const { redirectTo } = await helpers.completeAuthorization({
    request: {
      responseType: "code",
      clientId: client.clientId,
      redirectUri: HOOK_REDIRECT,
      scope: [],
      state: "p5",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource,
    },
    userId: user.id,
    metadata: { clientName: props.clientName },
    scope: [],
    props,
  });
  const code = new URL(redirectTo).searchParams.get("code") ?? "";
  const noApp = { fetch: () => new Response(null, { status: 404 }) };
  const ctx = execCtx(c) ?? {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  };
  const res = await oauthProvider(env, noApp).fetch(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: HOOK_REDIRECT,
        client_id: client.clientId,
        code_verifier: verifier,
        resource,
      }),
    }),
    env,
    ctx as ExecutionContext,
  );
  if (!res.ok) throw new ApiError("internal", "token exchange failed");
  const { access_token } = (await res.json()) as { access_token: string };
  return { clientId: client.clientId, accessToken: access_token };
}

/** Mounted before the session middleware; registers nothing unless the build allows hooks. */
export function mountTestHooks(app: AppType): void {
  if (!TEST_HOOKS_ALLOWED) return;
  app.all("/__test/*", async (c) => {
    if (!(await admitted(c)) || c.req.method !== "POST") return notFound();
    const path = c.req.path;
    const body = await c.req.json().catch(() => ({}));

    if (path === TEST_HOOKS.session) {
      const input = TestSessionInputSchema.safeParse(body);
      const email = input.success ? normEmail(input.data.email) : null;
      if (!input.success || !email)
        throw new ApiError("bad_request", "Invalid session hook input");
      const user = await upsertWithRole(c.env, email, input.data.role);
      await applyTestSpaceRoles(c.env, user.id, input.data.spaces ?? []);
      const row = await getUserWithEpoch(c.env, user.id);
      const cookie = await signSession(c.env, user.id, Date.now(), {
        provider: "test",
        epoch: row?.sessionEpoch ?? 0,
      });
      log("session");
      return c.json({ cookie });
    }

    if (path === TEST_HOOKS.otpLatest) {
      const input = OtpLatestInputSchema.safeParse(body);
      if (!input.success) throw new ApiError("bad_request", "Invalid input");
      const ek = await emailKey(c.env, input.data.email);
      const code = await c.env.OAUTH_KV.get(
        otpKvKey(authConfig(c.env).installKey, ek),
      );
      log("otp");
      return code ? c.json({ code }) : notFound();
    }

    if (path === TEST_HOOKS.oauthClient) {
      const out = await oauthClientFor(c);
      log("oauth_client");
      return c.json(out);
    }

    return notFound();
  });
}
