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
