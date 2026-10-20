import { ANON_ID_SHORT_LEN } from "@oa/shared";
import type { Env } from "../env.js";
import { b64urlEncode, hmacSign, hmacVerify } from "../util/crypto.js";

/**
 * Signed per-browser anonymous id (spec: anonymous viewers of artifacts with
 * allowAnonymousWrites). Token: "<id>.<sig>", id = base64url(16 random bytes)
 * (22 chars), sig = base64url(HMAC-SHA256(k, "anon:" + id)) (43 chars), where
 * k = HMAC-SHA256(SESSION_SECRET, "oa/anon-id/v1"): a derived key, so an
 * anon token can never be a session or content signature and vice versa.
 * Rotating SESSION_SECRET resets every anonId. Never logged.
 */
const TOKEN_RE =
  /^([A-Za-z0-9_-]{21}[AQgw])\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const KEY_LABEL = "oa/anon-id/v1";

let derived: { secret: string; key: Promise<string> } | null = null;
function anonKey(env: Pick<Env, "SESSION_SECRET">): Promise<string> {
  const s = env.SESSION_SECRET;
  if (typeof s !== "string" || s.length < 32)
    throw new Error("SESSION_SECRET must be at least 32 characters");
  if (derived?.secret !== s) {
    const key = hmacSign(s, KEY_LABEL);
    key.catch(() => {
      if (derived?.key === key) derived = null;
    });
    derived = { secret: s, key };
  }
  return derived.key;
}

export type AnonId = {
  /** The first ANON_ID_SHORT_LEN chars of the id: public (updatedBy, viewer.get). */
  short: string;
  /** Set when a new token was minted; return it to the shell. Secret-ish: never log. */
  issued: string | null;
};

/** Verifies `token`; mints a fresh one when it is missing, malformed or forged. */
export async function resolveAnonId(
  env: Pick<Env, "SESSION_SECRET">,
  token: string | undefined,
): Promise<AnonId> {
  const key = await anonKey(env);
  const m = token ? TOKEN_RE.exec(token) : null;
  if (m && (await hmacVerify(key, `anon:${m[1]}`, m[2] as string)))
    return {
      short: (m[1] as string).slice(0, ANON_ID_SHORT_LEN),
      issued: null,
    };
  const id = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const sig = await hmacSign(key, `anon:${id}`);
  return { short: id.slice(0, ANON_ID_SHORT_LEN), issued: `${id}.${sig}` };
}
