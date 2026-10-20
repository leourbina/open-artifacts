import { LIMITS } from "@oa/shared";
import type { Env } from "../env.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";

/** Clock-skew allowance on top of the TTL when rejecting far-future exps. */
const SKEW_SEC = 60;
const TOKEN = /^([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/;

/**
 * What a signed URL may do. "frame" (the default): the viewer iframe and its
 * sub-resources; a top-level navigation redirects to the app. "dl": an
 * explicit download (`?dl=1`), Content-Disposition attachment, served even top
 * level since an attachment renders nothing.
 */
export type SignMode = "frame" | "dl";

/**
 * Server-side thumbnail capture sends this header (`{exp}.{sig}`) on its
 * main-frame document requests to the content origin; with it, and only with
 * it, the content host renders top level. It is never in a URL, so the
 * artifact's script can't read it (thumbs.ts shoot()).
 */
export const CAPTURE_HEADER = "X-OA-Capture";
/** Upper bound on a capture header's lifetime. */
export const CAPTURE_MAX_TTL_SEC = 120;

function signingKey(env: Env): string {
  const k = env.CONTENT_SIGNING_KEY;
  if (typeof k !== "string" || k.length < 32)
    throw new Error("CONTENT_SIGNING_KEY must be at least 32 characters");
  return k;
}

/** The mode is in the MAC: a frame token can't be turned into dl. */
const payload = (id: string, v: number, exp: number, mode: SignMode) =>
  mode === "frame" ? `${id}:${v}:${exp}` : `${id}:${v}:${exp}:${mode}`;
const capturePayload = (id: string, v: number, exp: number) =>
  `${id}:${v}:${exp}:capture`;

/**
 * `now` is epoch ms; returns the prefix and its expiry (epoch seconds).
 * `ttlSec` may only shorten LIMITS.signedUrlTtlSec (verification caps it).
 * A "dl" prefix is valid only with `?dl=1` (see signDownload).
 */
export async function signContent(
  env: Env,
  id: string,
  v: number,
  now = Date.now(),
  ttlSec: number = LIMITS.signedUrlTtlSec,
  mode: SignMode = "frame",
): Promise<{ prefix: string; exp: number }> {
  const exp = Math.floor(now / 1000) + Math.min(ttlSec, LIMITS.signedUrlTtlSec);
  const sig = await hmacSign(signingKey(env), payload(id, v, exp, mode));
  return { prefix: `/c/${exp}.${sig}/${id}/v${v}/`, exp };
}

/** "/c/{exp}.{sig}/{id}/v{v}/", valid for LIMITS.signedUrlTtlSec. */
export async function signContentPrefix(
  env: Env,
  id: string,
  v: number,
  now = Date.now(),
): Promise<string> {
  return (await signContent(env, id, v, now)).prefix;
}

/**
 * A download URL path for one file: `/c/{exp}.{sig}/{id}/v{v}/{path}?dl=1`,
 * signed in the "dl" mode. `path` is a manifest path (encoded here).
 */
export async function signDownload(
  env: Env,
  id: string,
  v: number,
  path: string,
  now = Date.now(),
): Promise<{ path: string; exp: number }> {
  const { prefix, exp } = await signContent(
    env,
    id,
    v,
    now,
    LIMITS.signedUrlTtlSec,
    "dl",
  );
  const p = path.split("/").map(encodeURIComponent).join("/");
  return { path: `${prefix}${p}?dl=1`, exp };
}

/** `{exp}.{sig}` within (now, now + maxTtl + skew]; null when malformed or out of window. */
function window_(token: string, maxTtl: number, now: number) {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const exp = Number(m[1]);
  const nowSec = Math.floor(now / 1000);
  if (exp <= nowSec || exp > nowSec + maxTtl + SKEW_SEC) return null;
  return { exp, sig: m[2] ?? "" };
}

/**
 * Strict `{exp}.{sig}`: unexpired, not far-future, constant-time HMAC check.
 * `dl` is whether the request carries `?dl=1`: it selects the "dl" mode, so
 * adding or removing it breaks the signature. Returns the mode, or null.
 */
export async function verifyContentToken(
  env: Env,
  token: string,
  id: string,
  v: number,
  dl: boolean,
  now = Date.now(),
): Promise<SignMode | null> {
  const t = window_(token, LIMITS.signedUrlTtlSec, now);
  if (!t) return null;
  const mode: SignMode = dl ? "dl" : "frame";
  const ok = await hmacVerify(
    signingKey(env),
    payload(id, v, t.exp, mode),
    t.sig,
  );
  return ok ? mode : null;
}

/** A frame-mode `{exp}.{sig}` token for id and v (see verifyContentToken). */
export async function verifyContentPrefix(
  env: Env,
  token: string,
  id: string,
  v: number,
  now = Date.now(),
): Promise<boolean> {
  return (await verifyContentToken(env, token, id, v, false, now)) === "frame";
}

/** The CAPTURE_HEADER value for one capture of id at v. */
export async function signCapture(
  env: Env,
  id: string,
  v: number,
  now = Date.now(),
  ttlSec = 60,
): Promise<string> {
  const exp = Math.floor(now / 1000) + Math.min(ttlSec, CAPTURE_MAX_TTL_SEC);
  return `${exp}.${await hmacSign(signingKey(env), capturePayload(id, v, exp))}`;
}

/** Whether a CAPTURE_HEADER value is valid now for id at v. */
export async function verifyCapture(
  env: Env,
  value: string | undefined,
  id: string,
  v: number,
  now = Date.now(),
): Promise<boolean> {
  if (!value) return false;
  const t = window_(value.trim(), CAPTURE_MAX_TTL_SEC, now);
  if (!t) return false;
  return hmacVerify(signingKey(env), capturePayload(id, v, t.exp), t.sig);
}

/** "/p/{id}/v{v}/" (public artifacts only; checked per request). */
export function publicPrefix(id: string, v: number): string {
  return `/p/${id}/v${v}/`;
}
