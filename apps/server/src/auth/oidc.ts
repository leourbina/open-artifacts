import { AUTH } from "@oa/shared";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../util/crypto.js";

export const OIDC_COOKIE = "oa_oidc";
const OIDC_MAX_AGE_S = 600;
const MAX_NEXT_LEN = 2048;
const MAX_COOKIE_LEN = 4096;
const CLOCK_TOLERANCE_S = 60;

type OidcState = {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
};

export function accessIssuer(env: Env): string {
  return `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID}`;
}

const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callback}`;

const unsafePrefix = (p: string) =>
  !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\");

/**
 * Same-origin path or "/". The normalized output is re-checked (dot segments and
 * backslashes can resolve to "//host"), and the cap applies to the serialized,
 * percent-encoded form so the oa_oidc cookie stays small.
 */
export function safeNext(env: Env, next: string | undefined | null): string {
  if (typeof next !== "string" || next.length > MAX_NEXT_LEN) return "/";
  if (unsafePrefix(next)) return "/";
  const origin = appOrigin(env);
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin) return "/";
    const out = `${u.pathname}${u.search}${u.hash}`;
    if (out.length > MAX_NEXT_LEN || unsafePrefix(out)) return "/";
    return out;
  } catch {
    return "/";
  }
}

function requireSecret(env: Env): string {
  const s = env.SESSION_SECRET;
  if (typeof s !== "string" || s.length < 32)
    throw new Error("SESSION_SECRET must be at least 32 characters");
  return s;
}

const randomB64 = (n: number) =>
  b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));

async function s256(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return b64urlEncode(new Uint8Array(d));
}

function oidcCookie(env: Env, value: string, maxAge: number): string {
  const secure = env.ENVIRONMENT === "dev" ? "" : " Secure;";
  return `${OIDC_COOKIE}=${value}; HttpOnly;${secure} SameSite=Lax; Path=/auth; Max-Age=${maxAge}`;
}

export const clearOidcCookie = (env: Env) => oidcCookie(env, "", 0);

export async function buildAuthorizeRedirect(
  env: Env,
  next: string,
): Promise<{ location: string; stateCookie: string }> {
  const secret = requireSecret(env);
  const st: OidcState = {
    state: randomB64(32),
    nonce: randomB64(32),
    verifier: randomB64(32),
    next: safeNext(env, next),
    exp: Date.now() + OIDC_MAX_AGE_S * 1000,
  };
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(st)));
  const value = `${p}.${await hmacSign(secret, p)}`;
  const u = new URL(`${accessIssuer(env)}/authorization`);
  u.search = new URLSearchParams({
    client_id: env.ACCESS_CLIENT_ID,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri(env),
    state: st.state,
    nonce: st.nonce,
    code_challenge: await s256(st.verifier),
    code_challenge_method: "S256",
  }).toString();
  return {
    location: u.toString(),
    stateCookie: oidcCookie(env, value, OIDC_MAX_AGE_S),
  };
}

const fail = (): never => {
  throw new ApiError("unauthorized", "Login failed");
};

function readCookie(req: Request, name: string): string | undefined {
  const h = req.headers.get("cookie");
  if (!h) return undefined;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return undefined;
}

async function readOidcState(
  secret: string,
  value: string | undefined,
): Promise<OidcState | null> {
  if (!value || value.length > MAX_COOKIE_LEN) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [p, sig] = parts as [string, string];
  if (!(await hmacVerify(secret, p, sig))) return null;
  const raw = b64urlDecode(p);
  if (!raw) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(raw)) as Partial<OidcState>;
    if (
      !o ||
      typeof o.state !== "string" ||
      typeof o.nonce !== "string" ||
      typeof o.verifier !== "string" ||
      typeof o.next !== "string" ||
      typeof o.exp !== "number" ||
      !Number.isFinite(o.exp) ||
      o.exp <= Date.now()
    )
      return null;
    return o as OidcState;
  } catch {
    return null;
  }
}

/** Constant-time string equality via HMAC verify. */
async function safeEqual(secret: string, a: string, b: string) {
  return hmacVerify(secret, a, await hmacSign(secret, b));
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(issuer: string) {
  let s = jwksCache.get(issuer);
  if (!s) {
    s = createRemoteJWKSet(new URL(`${issuer}/jwks`));
    jwksCache.set(issuer, s);
  }
  return s;
}

/** Throws ApiError("unauthorized") on every failure; never leaks upstream detail. */
export async function handleCallback(
  env: Env,
  req: Request,
): Promise<{ email: string; name: string | null; next: string }> {
  const secret = requireSecret(env);
  const q = new URL(req.url).searchParams;
  const st = await readOidcState(secret, readCookie(req, OIDC_COOKIE));
  if (!st) return fail();
  const state = q.get("state") ?? "";
  if (!(await safeEqual(secret, state, st.state))) return fail();
  const code = q.get("code");
  if (q.has("error") || !code) return fail();

  const issuer = accessIssuer(env);
  let idToken: unknown;
  try {
    const res = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(env),
        client_id: env.ACCESS_CLIENT_ID,
        client_secret: env.ACCESS_CLIENT_SECRET,
        code_verifier: st.verifier,
      }),
      redirect: "manual",
    });
    if (!res.ok) {
      await res.body?.cancel();
      return fail();
    }
    idToken = ((await res.json()) as { id_token?: unknown } | null)?.id_token;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail();
  }
  if (typeof idToken !== "string") return fail();

  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(idToken as string, jwks(issuer), {
      issuer,
      audience: env.ACCESS_CLIENT_ID,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ["exp", "nonce"],
    }));
  } catch {
    return fail();
  }
  // Access sets aud to the client id; reject multi-audience tokens outright.
  const aud = claims.aud;
  if (
    Array.isArray(aud) &&
    (aud.length !== 1 || aud[0] !== env.ACCESS_CLIENT_ID)
  )
    return fail();
  if (
    typeof claims.nonce !== "string" ||
    !(await safeEqual(secret, claims.nonce, st.nonce))
  )
    return fail();
  const email = claims.email;
  if (typeof email !== "string" || !email.includes("@")) return fail();
  if (claims.email_verified === false) return fail();
  const name =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim().slice(0, 200)
      : null;
  // Normalization (and ASCII-only rejection) happens in upsertOnLogin.
  return { email: email.trim(), name, next: safeNext(env, st.next) };
}
