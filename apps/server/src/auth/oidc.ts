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

const tag = (v: unknown) =>
  typeof v === "string"
    ? v
        .toLowerCase()
        .replace(/[^a-z_]/g, "")
        .slice(0, 64)
    : undefined;

/**
 * Structured failure log. Callers pass only a fixed stage and sanitized
 * enum-like extras: never tokens, codes, emails, state values or secrets.
 */
export function logOidcFail(
  stage: string,
  extra: Record<string, string | undefined> = {},
): void {
  console.warn(JSON.stringify({ evt: "oidc_fail", stage, ...extra }));
}

const fail = (
  stage: string,
  extra?: Record<string, string | undefined>,
): never => {
  logOidcFail(stage, extra);
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
): Promise<OidcState | "no_state_cookie" | "state_bad_sig" | "state_expired"> {
  if (!value) return "no_state_cookie";
  if (value.length > MAX_COOKIE_LEN) return "state_bad_sig";
  const parts = value.split(".");
  if (parts.length !== 2) return "state_bad_sig";
  const [p, sig] = parts as [string, string];
  if (!(await hmacVerify(secret, p, sig))) return "state_bad_sig";
  const raw = b64urlDecode(p);
  if (!raw) return "state_bad_sig";
  try {
    const o = JSON.parse(new TextDecoder().decode(raw)) as Partial<OidcState>;
    if (
      !o ||
      typeof o.state !== "string" ||
      typeof o.nonce !== "string" ||
      typeof o.verifier !== "string" ||
      typeof o.next !== "string" ||
      typeof o.exp !== "number" ||
      !Number.isFinite(o.exp)
    )
      return "state_bad_sig";
    if (o.exp <= Date.now()) return "state_expired";
    return o as OidcState;
  } catch {
    return "state_bad_sig";
  }
}

const desc = (v: unknown) =>
  typeof v === "string"
    ? // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
      v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200)
    : undefined;

/**
 * IdP error/error_description from a failed token response (never the body
 * otherwise). Access answers token errors with a 302 to
 * redirect_uri?error=…&error_description=…; others use a JSON body.
 */
async function tokenErrorInfo(
  res: Response,
): Promise<{ error?: string; description?: string }> {
  try {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const loc = res.headers.get("location");
      if (!loc) return {};
      const p = new URL(loc, "https://invalid.local").searchParams;
      return {
        error: tag(p.get("error")),
        description: desc(p.get("error_description")),
      };
    }
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text();
      if (text.length > 16_384) return {};
      const j = JSON.parse(text) as {
        error?: unknown;
        error_description?: unknown;
      } | null;
      return { error: tag(j?.error), description: desc(j?.error_description) };
    }
    await res.body?.cancel();
  } catch {
    // non-JSON or malformed: stage alone is logged
  }
  return {};
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
  if (typeof st === "string") return fail(st);
  const state = q.get("state") ?? "";
  if (!(await safeEqual(secret, state, st.state)))
    return fail("state_mismatch");
  if (q.has("error")) return fail("idp_error", { error: tag(q.get("error")) });
  const code = q.get("code");
  if (!code) return fail("no_code");

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
    if (!res.ok)
      return fail(`token_http_${res.status}`, await tokenErrorInfo(res));
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return fail("token_bad_json");
    }
    idToken = (body as { id_token?: unknown } | null)?.id_token;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail("token_fetch");
  }
  if (typeof idToken !== "string") return fail("no_id_token");

  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(idToken as string, jwks(issuer), {
      issuer,
      audience: env.ACCESS_CLIENT_ID,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ["exp", "nonce"],
    }));
  } catch (e) {
    const err = e as { code?: unknown; claim?: unknown };
    return fail("jwt_verify", {
      code:
        typeof err?.code === "string"
          ? err.code.replace(/[^A-Z_]/g, "").slice(0, 64)
          : undefined,
      claim: tag(err?.claim),
    });
  }
  // Access sets aud to the client id; reject multi-audience tokens outright.
  const aud = claims.aud;
  if (
    Array.isArray(aud) &&
    (aud.length !== 1 || aud[0] !== env.ACCESS_CLIENT_ID)
  )
    return fail("aud");
  if (
    typeof claims.nonce !== "string" ||
    !(await safeEqual(secret, claims.nonce, st.nonce))
  )
    return fail("nonce");
  const email = claims.email;
  if (typeof email !== "string" || !email.includes("@")) return fail("email");
  if (claims.email_verified === false) return fail("email_unverified");
  const name =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim().slice(0, 200)
      : null;
  // Normalization (and ASCII-only rejection) happens in upsertOnLogin.
  return { email: email.trim(), name, next: safeNext(env, st.next) };
}
