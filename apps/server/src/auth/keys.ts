import type { Env } from "../env.js";
import { b64urlEncode } from "../util/crypto.js";

/**
 * Per-purpose HMAC keys derived from SESSION_SECRET, so a key used for one
 * cookie or table can never verify another's values:
 * base64url(HKDF-SHA256(ikm = SESSION_SECRET, salt = HKDF_SALT, info = label, 32 bytes)).
 * The result is the `key` string for util/crypto's hmacSign/hmacVerify.
 */
export const KEY_LABELS = [
  "oa:session",
  "oa:oidc-state",
  "oa:code-cookie",
  "oa:login-codes",
] as const;
export type KeyLabel = (typeof KEY_LABELS)[number];

const HKDF_SALT = "open-artifacts/hkdf/v1";
const enc = new TextEncoder();
const cache = new Map<string, Promise<string>>();

async function derive(secret: string, label: KeyLabel): Promise<string> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(HKDF_SALT),
      info: enc.encode(label),
    },
    ikm,
    256,
  );
  return b64urlEncode(new Uint8Array(bits));
}

export function deriveKey(
  env: Pick<Env, "SESSION_SECRET">,
  label: KeyLabel,
): Promise<string> {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32)
    return Promise.reject(
      new Error("SESSION_SECRET must be at least 32 characters"),
    );
  const id = `${label}\u0000${secret}`;
  let k = cache.get(id);
  if (!k) {
    k = derive(secret, label);
    k.catch(() => cache.delete(id));
    cache.set(id, k);
  }
  return k;
}

/** Shorter secrets can't key HKDF safely; cookies fall back to the raw secret. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Until then, cookies signed with the raw SESSION_SECRET (state and session,
 * from before the per-purpose keys) are still accepted. A follow-up removes
 * it; an install that upgrades after this date signs everyone out once.
 */
export const LEGACY_KEY_UNTIL = Date.UTC(2026, 11, 1);

export const SHORT_SECRET_PROBLEM =
  "SESSION_SECRET shorter than 32 characters; rotate it";

/** Install-level problems for /healthz and setup (never secret values). */
export function secretProblems(env: Pick<Env, "SESSION_SECRET">): string[] {
  const s = env.SESSION_SECRET;
  return typeof s === "string" && s.length > 0 && s.length < MIN_SECRET_LENGTH
    ? [SHORT_SECRET_PROBLEM]
    : [];
}

let warned = false;

/**
 * Keys for a cookie that predates the per-purpose keys (session, OIDC
 * state): `key` signs and verifies, `legacy` (if not null) also verifies.
 * - SESSION_SECRET of 32+ chars: the derived key; the raw secret also
 *   verifies until LEGACY_KEY_UNTIL.
 * - Shorter (older or hand-set installs): the raw secret only, as before P2,
 *   reported by secretProblems. Never an error, so such an install keeps
 *   signing people in.
 * - Missing or empty: throws (the install is misconfigured).
 */
export async function cookieKeys(
  env: Pick<Env, "SESSION_SECRET">,
  label: "oa:session" | "oa:oidc-state",
  now = Date.now(),
): Promise<{ key: string; legacy: string | null }> {
  const s = env.SESSION_SECRET;
  if (typeof s !== "string" || s.length === 0)
    throw new Error("SESSION_SECRET is not set");
  if (s.length < MIN_SECRET_LENGTH) {
    if (!warned) {
      warned = true;
      console.warn(JSON.stringify({ evt: "session_secret_short" }));
    }
    return { key: s, legacy: null };
  }
  return {
    key: await deriveKey(env, label),
    legacy: now < LEGACY_KEY_UNTIL ? s : null,
  };
}
