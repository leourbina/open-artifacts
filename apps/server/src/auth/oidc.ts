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

/*
 * OIDC login state.
 *
 * Each login attempt gets its own signed cookie `oa_oidc_<k>` where
 * k = first 10 base64url chars of sha256(state). The callback recomputes k
 * from the `state` query param to pick the cookie, then still verifies the
 * HMAC and compares state in constant time. Parallel tabs therefore don't
 * clobber each other, and at most MAX_ATTEMPTS cookies are kept (oldest by
 * signed exp evicted at login; unparseable ones first).
 *
 * Security: login CSRF is still prevented. A callback is accepted only if its
 * `state` equals the state inside an HMAC-signed cookie that this browser
 * holds (set by our own /auth/login, HttpOnly, SameSite=Lax, Path=/auth). An
 * attacker cannot plant such a cookie, and choosing a different `state` only
 * selects a different (absent) cookie name. k is a public hash prefix, not a
 * secret; nothing is accepted on k alone.
 *
 * State failures (missing / bad sig / expired / mismatch) redirect once to
 * /auth/login?retry=1. The retry flag rides in the signed payload and as a
 * public `r1.` prefix on `state` (so it survives even if the cookie never comes
 * back); a second state failure renders a static page instead: no loop.
 */
/** Legacy single cookie: accepted (read only) for one release. */
export const OIDC_COOKIE = "oa_oidc";
const OIDC_PREFIX = "oa_oidc_";
const OIDC_NAME_RE = /^oa_oidc_[A-Za-z0-9_-]{10}$/;
const OIDC_MAX_AGE_S = 900;
const MAX_ATTEMPTS = 3;
const MAX_SCANNED = 16;
const RETRY_MARK = "r1.";
const MAX_NEXT_LEN = 2048;
const MAX_COOKIE_LEN = 4096;
const CLOCK_TOLERANCE_S = 60;

type OidcState = {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
  retry?: boolean;
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

function oidcCookie(
  env: Env,
  name: string,
  value: string,
  maxAge: number,
): string {
  const secure = env.ENVIRONMENT === "dev" ? "" : " Secure;";
  return `${name}=${value}; HttpOnly;${secure} SameSite=Lax; Path=/auth; Max-Age=${maxAge}`;
}

export const clearOidcCookie = (env: Env, name: string) =>
  oidcCookie(env, name, "", 0);

/** Per-attempt cookie name for a state value. */
export async function stateCookieName(state: string): Promise<string> {
  return `${OIDC_PREFIX}${(await s256(state)).slice(0, 10)}`;
}

function parseCookies(header: string | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

/** Set-Cookie clears for the oldest attempts so that, with the new one, at most MAX_ATTEMPTS remain. */
async function evictions(
  env: Env,
  secret: string,
  cookieHeader: string | null | undefined,
): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const [n, v] of parseCookies(cookieHeader))
    if (OIDC_NAME_RE.test(n) && !seen.has(n)) seen.set(n, v);
  const excess = seen.size - (MAX_ATTEMPTS - 1);
  if (excess <= 0) return [];
  const ranked: { name: string; exp: number }[] = [];
  let scanned = 0;
  for (const [name, value] of seen) {
    // Bound HMAC work; anything past the cap is treated as unparseable.
    const r =
      scanned++ < MAX_SCANNED ? await readOidcState(secret, value) : null;
    ranked.push({ name, exp: r?.st ? r.st.exp : Number.NEGATIVE_INFINITY });
  }
  ranked.sort((a, b) => a.exp - b.exp);
  return ranked.slice(0, excess).map((x) => clearOidcCookie(env, x.name));
}

export async function buildAuthorizeRedirect(
  env: Env,
  next: string,
  opts: { retry?: boolean; cookieHeader?: string | null } = {},
): Promise<{ location: string; stateCookie: string; evict: string[] }> {
  const secret = requireSecret(env);
  const retry = opts.retry === true;
  const st: OidcState = {
    state: `${retry ? RETRY_MARK : ""}${randomB64(32)}`,
    nonce: randomB64(32),
    verifier: randomB64(32),
    next: safeNext(env, next),
    exp: Date.now() + OIDC_MAX_AGE_S * 1000,
    ...(retry ? { retry: true } : {}),
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
    stateCookie: oidcCookie(
      env,
      await stateCookieName(st.state),
      value,
      OIDC_MAX_AGE_S,
    ),
    evict: await evictions(env, secret, opts.cookieHeader),
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

/** State-cookie failure: the route redirects to a retry login (or the static page). */
export class OidcStateError extends ApiError {
  constructor(
    public next: string,
    public retry: boolean,
  ) {
    super("unauthorized", "Login failed");
  }
}

const fail = (
  stage: string,
  extra?: Record<string, string | undefined>,
): never => {
  logOidcFail(stage, extra);
  throw new ApiError("unauthorized", "Login failed");
};

/** The cookie for this attempt (by state), else the legacy cookie, else null. */
export async function pickStateCookie(
  req: Request,
  state: string,
): Promise<{ name: string; value: string } | null> {
  const jar = parseCookies(req.headers.get("cookie"));
  const want = await stateCookieName(state);
  for (const name of [want, OIDC_COOKIE]) {
    const hit = jar.find(([n]) => n === name);
    if (hit) return { name, value: hit[1] };
  }
  return null;
}

type StateRead =
  | { stage: null; st: OidcState }
  | { stage: "state_expired"; st: OidcState }
  | { stage: "state_bad_sig"; st?: undefined };

/** HMAC-verified payload; expired payloads are returned (for `next`/`retry`) but flagged. */
async function readOidcState(
  secret: string,
  value: string,
): Promise<StateRead> {
  const bad = { stage: "state_bad_sig" } as const;
  if (value.length > MAX_COOKIE_LEN) return bad;
  const parts = value.split(".");
  if (parts.length !== 2) return bad;
  const [p, sig] = parts as [string, string];
  if (!(await hmacVerify(secret, p, sig))) return bad;
  const raw = b64urlDecode(p);
  if (!raw) return bad;
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
      return bad;
    const st = o as OidcState;
    return st.exp <= Date.now()
      ? { stage: "state_expired", st }
      : { stage: null, st };
  } catch {
    return bad;
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
  const state = q.get("state") ?? "";
  const failState = (stage: string, from?: OidcState): never => {
    logOidcFail(stage);
    // `next` only from an HMAC-valid payload; retry from it or the public marker.
    throw new OidcStateError(
      safeNext(env, from?.next ?? "/"),
      from?.retry === true || state.startsWith(RETRY_MARK),
    );
  };
  const picked = await pickStateCookie(req, state);
  if (!picked) return failState("no_state_cookie");
  const read = await readOidcState(secret, picked.value);
  if (read.stage === "state_bad_sig") return failState("state_bad_sig");
  if (read.stage === "state_expired")
    return failState("state_expired", read.st);
  const st = read.st;
  if (!(await safeEqual(secret, state, st.state)))
    return failState("state_mismatch");
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
