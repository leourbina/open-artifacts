import { ANON_ID_SHORT_LEN } from "@oa/shared";
import type { Env } from "../env.js";
import { b64urlDecode, b64urlEncode } from "../util/crypto.js";

/**
 * Signed per-browser anonymous id, for anonymous viewers of artifacts with
 * allowAnonymousWrites. One global token per browser per app origin:
 * "<id>.<sig>", id = base64url(16 random bytes) (22 chars),
 * sig = base64url(HMAC-SHA256(k, "anon:" + id)) (43 chars), where
 * k = HKDF-SHA256(SESSION_SECRET, info "oa/anon-id/v1"). Rotating
 * SESSION_SECRET resets every anonId. The token is never logged.
 *
 * The public id is per artifact, so one browser can't be linked across
 * artifacts: short = base64url(HMAC-SHA256(k, "short:" + artifactId + ":" + id))
 * truncated to ANON_ID_SHORT_LEN chars.
 */
const TOKEN_RE =
  /^([A-Za-z0-9_-]{21}[AQgw])\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const enc = new TextEncoder();
const INFO = enc.encode("oa/anon-id/v1");

let derived: { secret: string; key: Promise<CryptoKey> } | null = null;
function anonKey(env: Pick<Env, "SESSION_SECRET">): Promise<CryptoKey> {
  const s = env.SESSION_SECRET;
  if (typeof s !== "string" || s.length < 32)
    throw new Error("SESSION_SECRET must be at least 32 characters");
  if (derived?.secret !== s) {
    const key = crypto.subtle
      .importKey("raw", enc.encode(s), "HKDF", false, ["deriveKey"])
      .then((ikm) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: INFO },
          ikm,
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign", "verify"],
        ),
      );
    key.catch(() => {
      if (derived?.key === key) derived = null;
    });
    derived = { secret: s, key };
  }
  return derived.key;
}

const sign = async (key: CryptoKey, data: string) =>
  b64urlEncode(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))),
  );

const shortOf = async (key: CryptoKey, artifactId: string, id: string) =>
  (await sign(key, `short:${artifactId}:${id}`)).slice(0, ANON_ID_SHORT_LEN);

export type AnonId = {
  /** The per-artifact public id (updatedBy "anon:<short>", viewer.get). */
  short: string;
  /** Set when a new token was minted; return it to the shell. Never log it. */
  issued: string | null;
};

/**
 * Verifies `token` and returns this artifact's short id for it. When it is
 * missing, malformed or forged: mints a fresh token if `mint`, else null.
 */
export async function resolveAnonId(
  env: Pick<Env, "SESSION_SECRET">,
  artifactId: string,
  token: string | undefined,
  mint: boolean,
): Promise<AnonId | null> {
  const m = token ? TOKEN_RE.exec(token) : null;
  if (!m && !mint) return null;
  const key = await anonKey(env);
  if (m) {
    const id = m[1] as string;
    const sig = b64urlDecode(m[2] as string);
    if (
      sig &&
      (await crypto.subtle.verify("HMAC", key, sig, enc.encode(`anon:${id}`)))
    )
      return { short: await shortOf(key, artifactId, id), issued: null };
  }
  if (!mint) return null;
  const id = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const issued = `${id}.${await sign(key, `anon:${id}`)}`;
  return { short: await shortOf(key, artifactId, id), issued };
}
