import {
  type Member,
  newId,
  type OAuthClientHookResult,
  OtpLatestInputSchema,
  type Role,
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
// stg-b. Release builds drop this module (`hooks` in app.ts folds to
// false). At runtime it is on only when the build allows it
// (TEST_HOOKS_ALLOWED) AND TEST_HOOKS=1 AND a 32+ char TEST_HOOK_KEY AND a
// TEST_DOMAIN. Order per request: rate limit (RL_ANON; unbound is a refusal),
// then the key, then the input. Every refusal is the standard 404, and every
// call past the rate limit writes one audit_events row.

const MIN_KEY = 32;
const OTP_TTL_S = 600;

type HookEnv = Pick<
  Env,
  "TEST_HOOKS" | "TEST_HOOK_KEY" | "TEST_DOMAIN" | "RL_ANON"
>;

export function testHooksOn(env: HookEnv): boolean {
  return (
    TEST_HOOKS_ALLOWED &&
    env.TEST_HOOKS === "1" &&
    typeof env.TEST_HOOK_KEY === "string" &&
    env.TEST_HOOK_KEY.length >= MIN_KEY &&
    typeof env.TEST_DOMAIN === "string" &&
    env.TEST_DOMAIN.length > 0
  );
}

/** KV key of the plaintext OTP copy: never the address itself. */
export const otpKvKey = (installKey: string, ek: string) =>
  `test:otp:${installKey}:${ek}`;

const domainOf = (email: string) => email.split("@")[1];

/** True only for a normalized address exactly under TEST_DOMAIN. */
const inTestDomain = (env: Env, email: string) =>
  domainOf(email) === env.TEST_DOMAIN;

/** While hooks are on only: a plaintext copy of a TEST_DOMAIN code P5 can read back. */
export async function recordTestOtp(
  env: Env,
  email: string,
  ek: string,
  code: string,
) {
  if (!testHooksOn(env) || !inTestDomain(env, email)) return;
  await env.OAUTH_KV.put(otpKvKey(authConfig(env).installKey, ek), code, {
    expirationTtl: OTP_TTL_S,
  });
}

/** Drops the plaintext copy once the code is used. */
export async function forgetTestOtp(env: Env, ek: string) {
  if (!testHooksOn(env)) return;
  await env.OAUTH_KV.delete(otpKvKey(authConfig(env).installKey, ek));
}

async function sameKey(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
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

type HookName = "session" | "otp_latest" | "oauth_client" | "unknown";
type Outcome = "ok" | "denied" | "refused" | "none" | "error";

const hookName = (path: string): HookName =>
  path === TEST_HOOKS.session
    ? "session"
    : path === TEST_HOOKS.otpLatest
      ? "otp_latest"
      : path === TEST_HOOKS.oauthClient
        ? "oauth_client"
        : "unknown";

// Same DDL as P3's audit_events (0009_spaces, also IF NOT EXISTS), so the
// rows land in the audit log on installs that predate that migration.
const AUDIT_DDL = [
  "CREATE TABLE IF NOT EXISTS `audit_events` (`id` text PRIMARY KEY NOT NULL, `at` integer NOT NULL, `actor_kind` text NOT NULL, `actor_id` text, `action` text NOT NULL, `target_type` text NOT NULL, `target_id` text, `space_id` text, `detail` text DEFAULT '{}' NOT NULL) WITHOUT ROWID",
  "CREATE INDEX IF NOT EXISTS `audit_events_at_idx` ON `audit_events` (`at`)",
];
const AUDIT_INSERT =
  "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, detail) values (?, ?, 'test_hook', ?, ?, 'test_hook', ?, ?)";

/** One audit row per hook call: hook, IP, outcome, and the email's domain (never the address). */
async function audit(
  env: Env,
  hook: HookName,
  ip: string,
  outcome: Outcome,
  o: { email?: string; userId?: string } = {},
): Promise<void> {
  const detail: Record<string, string> = { hook, ip, outcome };
  if (o.email !== undefined) detail.domain = domainOf(o.email) ?? "";
  await env.DB.batch([
    ...AUDIT_DDL.map((s) => env.DB.prepare(s)),
    env.DB.prepare(AUDIT_INSERT).bind(
      newId(),
      Date.now(),
      o.userId ?? null,
      `test_hook.${hook}`,
      hook,
      JSON.stringify(detail),
    ),
  ]);
  log(outcome === "ok" ? hook : outcome);
}

/** The user's current role, or null when there is no such user. */
const currentRole = (env: Env, email: string) =>
  env.DB.prepare("select role from users where email = ? limit 1")
    .bind(email)
    .first<string>("role");

/**
 * A user the hooks may act on: TEST_DOMAIN only, never the owner, and never a
 * role change for an existing user. Null means refuse.
 */
async function testUser(
  env: Env,
  email: string,
  role: Role,
): Promise<Member | null> {
  if (!inTestDomain(env, email)) return null;
  if (email === normEmail(env.OWNER_EMAIL ?? "")) return null;
  const now = await currentRole(env, email);
  if (now !== null && now !== role) return null;
  return upsertWithRole(env, email, role);
}

/** P3 owns space roles; until it lands, a session hook asking for them is refused. */
const spacesSupported = (spaces: unknown[]) => spaces.length === 0;

// A loopback redirect: the grant is completed server-side, nothing follows it.
const HOOK_REDIRECT = "http://127.0.0.1/p5-oauth-callback";

/** A registered client and an access token for `user`, via the real provider. */
async function oauthClientFor(
  c: Context<AppEnv>,
  user: Member,
): Promise<OAuthClientHookResult> {
  const env = c.env;
  const origin = appOrigin(env);
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

/** The OAuth hook's member: one fixed address under TEST_DOMAIN. */
export const oauthHookEmail = (env: Pick<Env, "TEST_DOMAIN">) =>
  `p5-oauth@${env.TEST_DOMAIN}`;

/** Mounted before the session middleware; registers nothing unless the build allows hooks. */
export function mountTestHooks(app: AppType): void {
  if (!TEST_HOOKS_ALLOWED) return;
  app.all("/__test/*", async (c) => {
    const env = c.env;
    if (!testHooksOn(env)) return notFound();
    // Rate limit first, before any key work; no limiter bound means refuse.
    const rl = env.RL_ANON;
    if (!rl) return notFound();
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const limited = !(
      await rl.limit({ key: `test:${authConfig(env).installKey}:${ip}` })
    ).success;
    if (limited) {
      log("limited");
      return notFound();
    }
    const hook = hookName(c.req.path);
    const given = BEARER.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (!(await sameKey(given, env.TEST_HOOK_KEY as string))) {
      await audit(env, hook, ip, "denied");
      return notFound();
    }
    if (c.req.method !== "POST" || hook === "unknown") {
      await audit(env, hook, ip, "refused");
      return notFound();
    }
    const body = await c.req.json().catch(() => ({}));

    if (hook === "session") {
      const input = TestSessionInputSchema.safeParse(body);
      if (!input.success) {
        await audit(env, hook, ip, "refused");
        return notFound();
      }
      const { email: raw, role, spaces = [] } = input.data;
      const email = normEmail(raw);
      const user =
        email && spacesSupported(spaces)
          ? await testUser(env, email, role)
          : null;
      if (!user) {
        await audit(env, hook, ip, "refused", email ? { email } : {});
        return notFound();
      }
      const row = await getUserWithEpoch(env, user.id);
      const cookie = await signSession(env, user.id, Date.now(), {
        provider: "test",
        epoch: row?.sessionEpoch ?? 0,
      });
      await audit(env, hook, ip, "ok", { email: user.email, userId: user.id });
      return c.json({ cookie });
    }

    if (hook === "otp_latest") {
      const input = OtpLatestInputSchema.safeParse(body);
      const email = input.success ? normEmail(input.data.email) : null;
      if (!email || !inTestDomain(env, email)) {
        await audit(env, hook, ip, "refused", email ? { email } : {});
        return notFound();
      }
      const ek = await emailKey(env, email);
      const code = await env.OAUTH_KV.get(
        otpKvKey(authConfig(env).installKey, ek),
      );
      await audit(env, hook, ip, code ? "ok" : "none", { email });
      return code ? c.json({ code }) : notFound();
    }

    const email = oauthHookEmail(env);
    const user = normEmail(email) ? await testUser(env, email, "member") : null;
    if (!user) {
      await audit(env, hook, ip, "refused", { email });
      return notFound();
    }
    const out = await oauthClientFor(c, user);
    await audit(env, hook, ip, "ok", { email, userId: user.id });
    return c.json(out);
  });
}
