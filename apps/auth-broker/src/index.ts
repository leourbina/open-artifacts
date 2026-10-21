// Hosted auth broker (P2 T11): Sign in with Google for every hosted install
// through ONE multi-tenant Google client. Stateless. It holds the Google client
// secret and nothing that can sign for an install:
// - GET  /google/authorize  install → Google, with the install's own nonce and
//   PKCE challenge, and a signed broker state naming the install.
// - GET  /google/callback   Google → the install's registered origin only.
// - POST /google/redeem     the install (Ed25519-signed, within 60 s) trades
//   the code for Google's raw ID token, returned unmodified. The install
//   verifies it itself (signature, aud, its nonce, hd); the broker never
//   vouches for anyone.
import {
  brokerNonce,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  keyId,
  verifyRedeem,
} from "@oa/auth-core";
import { lookupInstall } from "./registry.js";

export interface Env {
  BROKER_REGISTRY: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /**
   * The broker's fixed public origin (https://auth.<hosted>). redirect_uri is
   * always built from this var, never from the request Host: the one URI
   * registered with Google must not move with a forged or proxied Host header.
   */
  BROKER_ORIGIN: string;
  /** HMAC key for the broker's own state parameter (32+ chars). */
  BROKER_STATE_KEY: string;
  /** Per-IP and per-install rate limits; unbound means fail closed (503). */
  RL_BROKER_IP?: RateLimit;
  RL_BROKER_INSTALL?: RateLimit;
}

const STATE_TTL_MS = 10 * 60_000;
const REDEEM_SKEW_MS = 60_000;
const MAX_BODY = 4096;
/** S256 of 32 bytes, base64url: exactly what the installs generate. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder();

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: string): string | null => {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
};

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
const notFound = () => json({ error: "not_found" }, 404);
const refused = () => json({ error: "unauthorized" }, 401);

/** One line per outcome; never a code, verifier, token, email or key. */
const log = (route: string, outcome: string) =>
  console.log(JSON.stringify({ evt: "broker", route, outcome }));

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

async function sha256B64(data: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return b64(new Uint8Array(d));
}

/**
 * The broker state binds the exact flow: install, the install's client state,
 * H(client nonce || code challenge), and a short expiry. A state minted for
 * one nonce/challenge pair can't be replayed for another.
 */
type BrokerState = { i: string; s: string; h: string; exp: number };

async function signState(env: Env, st: BrokerState): Promise<string> {
  const p = b64(enc.encode(JSON.stringify(st)));
  return `${p}.${b64(await hmac(env.BROKER_STATE_KEY, p))}`;
}

async function readState(
  env: Env,
  v: string,
  now: number,
): Promise<BrokerState | null> {
  const [p, sig, extra] = v.split(".");
  if (!p || !sig || extra !== undefined) return null;
  const want = await hmac(env.BROKER_STATE_KEY, p);
  const got = unb64(sig);
  if (
    got === null ||
    !same(
      want,
      Uint8Array.from(got, (c) => c.charCodeAt(0)),
    )
  )
    return null;
  try {
    const raw = unb64(p);
    const st = raw ? (JSON.parse(raw) as BrokerState) : null;
    if (
      !st ||
      typeof st.i !== "string" ||
      typeof st.s !== "string" ||
      typeof st.h !== "string"
    )
      return null;
    return typeof st.exp === "number" && st.exp > now ? st : null;
  } catch {
    return null;
  }
}

/** The fixed public origin, or null when BROKER_ORIGIN is missing/invalid. */
function fixedOrigin(env: Env): string | null {
  try {
    const u = new URL(env.BROKER_ORIGIN);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

const callbackUrl = (origin: string) => `${origin}/google/callback`;

const ipOf = (req: Request) =>
  req.headers.get("cf-connecting-ip")?.trim() || "unknown";

/**
 * Charges both buckets before any Google or registry work: per IP, then per
 * install. A missing binding fails closed (503) rather than unlimited.
 */
async function rateLimited(
  env: Env,
  req: Request,
  install: string,
): Promise<Response | null> {
  const ip = env.RL_BROKER_IP;
  const byInstall = env.RL_BROKER_INSTALL;
  if (!ip || !byInstall)
    return log("rate_limit", "unbound"), json({ error: "unavailable" }, 503);
  if (!(await ip.limit({ key: `ip:${ipOf(req)}` })).success)
    return log("rate_limit", "ip"), json({ error: "rate_limited" }, 429);
  if (!(await byInstall.limit({ key: `install:${install}` })).success)
    return log("rate_limit", "install"), json({ error: "rate_limited" }, 429);
  return null;
}

async function authorize(
  req: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const install = q.get("install") ?? "";
  const state = q.get("state") ?? "";
  const nonce = q.get("nonce") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  if (
    !state ||
    !nonce ||
    !CHALLENGE_RE.test(challenge) ||
    state.length > 512 ||
    nonce.length > 512
  )
    return notFound();
  const origin = fixedOrigin(env);
  if (!origin)
    return (
      log("authorize", "misconfigured"), json({ error: "server_error" }, 500)
    );
  const limited = await rateLimited(env, req, install);
  if (limited) return limited;
  const entry = await lookupInstall(env.BROKER_REGISTRY, install, now);
  if (!entry) return log("authorize", "unknown_install"), notFound();
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(origin),
    response_type: "code",
    scope: "openid email profile",
    state: await signState(env, {
      i: install,
      s: state,
      h: await sha256B64(`${nonce}|${challenge}`),
      exp: now + STATE_TTL_MS,
    }),
    // One Google client, one redirect URI: bind the nonce to this install so
    // a token minted through another install can never redeem here. The
    // install keeps `nonce` itself and recomputes this for verification.
    nonce: await brokerNonce(install, nonce),
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    ...(entry.domains?.[0] ? { hd: entry.domains[0] } : {}),
  }).toString();
  log("authorize", "ok");
  return Response.redirect(u.toString(), 302);
}

async function callback(
  req: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const st = await readState(env, q.get("state") ?? "", now);
  if (!st) return log("callback", "bad_state"), notFound();
  const entry = await lookupInstall(env.BROKER_REGISTRY, st.i, now);
  if (!entry) return log("callback", "unknown_install"), notFound();
  // Only the registry decides where the user goes next.
  const to = new URL("/auth/callback/google", entry.origin);
  const code = q.get("code");
  const error = q.get("error");
  if (code) to.searchParams.set("code", code);
  else
    to.searchParams.set(
      "error",
      error && /^[a-z_]{1,64}$/.test(error) ? error : "access_denied",
    );
  to.searchParams.set("state", st.s);
  log("callback", code ? "ok" : "idp_error");
  return new Response(null, {
    status: 302,
    headers: {
      location: to.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

type Redeem = { install: string; code: string; verifier: string; ts: number };

async function redeem(req: Request, env: Env, now: number): Promise<Response> {
  const kid = req.headers.get("x-oa-kid") ?? "";
  const sig = req.headers.get("x-oa-sig") ?? "";
  const text = await req.text();
  if (text.length > MAX_BODY) return refused();
  let body: Redeem;
  try {
    body = JSON.parse(text) as Redeem;
  } catch {
    return refused();
  }
  if (
    typeof body?.install !== "string" ||
    typeof body.code !== "string" ||
    typeof body.verifier !== "string" ||
    typeof body.ts !== "number"
  )
    return refused();
  const origin = fixedOrigin(env);
  if (!origin)
    return log("redeem", "misconfigured"), json({ error: "server_error" }, 500);
  const limited = await rateLimited(env, req, body.install);
  if (limited) return limited;
  const entry = await lookupInstall(env.BROKER_REGISTRY, body.install, now);
  if (!entry) return log("redeem", "unknown_install"), refused();
  // The kid must be one of this install's keys AND derive from its x.
  let x: string | null = null;
  for (const k of entry.keys)
    if (k.kid === kid && (await keyId(k.x)) === kid) x = k.x;
  // The signature covers method, path, kid and body: a valid redeem can't be
  // transplanted to another route or replayed under another key id.
  if (!x || !(await verifyRedeem(x, kid, text, sig)))
    return log("redeem", "bad_signature"), refused();
  if (Math.abs(now - body.ts) > REDEEM_SKEW_MS)
    return log("redeem", "stale"), refused();

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: body.code,
      redirect_uri: callbackUrl(origin),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code_verifier: body.verifier,
    }),
    redirect: "manual",
  }).catch(() => null);
  if (!res?.ok) {
    await res?.body?.cancel();
    return (
      log("redeem", "exchange_failed"), json({ error: "exchange_failed" }, 400)
    );
  }
  const out = (await res.json().catch(() => null)) as {
    id_token?: unknown;
  } | null;
  if (typeof out?.id_token !== "string")
    return (
      log("redeem", "no_id_token"), json({ error: "exchange_failed" }, 400)
    );
  log("redeem", "ok");
  return json({ id_token: out.id_token });
}

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);
    const now = Date.now();
    if (req.method === "GET" && pathname === "/google/authorize")
      return authorize(req, env, now);
    if (req.method === "GET" && pathname === "/google/callback")
      return callback(req, env, now);
    if (req.method === "POST" && pathname === "/google/redeem")
      return redeem(req, env, now);
    return notFound();
  },
} satisfies ExportedHandler<Env>;
