import { LIMITS } from "@oa/shared";
import type { Env } from "../env.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";

/** Clock-skew allowance on top of the TTL when rejecting far-future exps. */
const SKEW_SEC = 60;
const TOKEN = /^([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/;

function signingKey(env: Env): string {
  const k = env.CONTENT_SIGNING_KEY;
  if (typeof k !== "string" || k.length < 32)
    throw new Error("CONTENT_SIGNING_KEY must be at least 32 characters");
  return k;
}

const payload = (id: string, v: number, exp: number) => `${id}:${v}:${exp}`;

/**
 * `now` is epoch ms; returns the prefix and its expiry (epoch seconds).
 * `ttlSec` may only shorten LIMITS.signedUrlTtlSec (verification caps it).
 */
export async function signContent(
  env: Env,
  id: string,
  v: number,
  now = Date.now(),
  ttlSec: number = LIMITS.signedUrlTtlSec,
): Promise<{ prefix: string; exp: number }> {
  const exp = Math.floor(now / 1000) + Math.min(ttlSec, LIMITS.signedUrlTtlSec);
  const sig = await hmacSign(signingKey(env), payload(id, v, exp));
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

/** Strict `{exp}.{sig}`: unexpired, not far-future, constant-time HMAC check. */
export async function verifyContentPrefix(
  env: Env,
  token: string,
  id: string,
  v: number,
  now = Date.now(),
): Promise<boolean> {
  const m = TOKEN.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  const nowSec = Math.floor(now / 1000);
  if (exp <= nowSec || exp > nowSec + LIMITS.signedUrlTtlSec + SKEW_SEC)
    return false;
  return hmacVerify(signingKey(env), payload(id, v, exp), m[2] ?? "");
}

/** "/p/{id}/v{v}/" (public artifacts only; checked per request). */
export function publicPrefix(id: string, v: number): string {
  return `/p/${id}/v${v}/`;
}
