import { isId } from "@oa/shared";
import type { Env } from "../env.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../util/crypto.js";

export type Session = { uid: string; exp: number };

const MAX_AGE_S = 7 * 86400;
const MAX_COOKIE_LEN = 1024;

export async function signSession(
  env: Env,
  uid: string,
  now = Date.now(),
): Promise<string> {
  if (typeof env.SESSION_SECRET !== "string" || env.SESSION_SECRET.length < 32)
    throw new Error("SESSION_SECRET must be at least 32 characters");
  if (!isId(uid)) throw new Error("invalid uid");
  const payload: Session = { uid, exp: now + MAX_AGE_S * 1000 };
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${p}.${await hmacSign(env.SESSION_SECRET, p)}`;
}

export async function readSession(
  env: Env,
  cookieValue: string | undefined,
  now = Date.now(),
): Promise<Session | null> {
  if (!cookieValue || cookieValue.length > MAX_COOKIE_LEN) return null;
  try {
    const parts = cookieValue.split(".");
    if (parts.length !== 2) return null;
    const [p, sig] = parts as [string, string];
    if (!(await hmacVerify(env.SESSION_SECRET, p, sig))) return null;
    const raw = b64urlDecode(p);
    if (!raw) return null;
    const s = JSON.parse(
      new TextDecoder().decode(raw),
    ) as Partial<Session> | null;
    if (!s || typeof s.uid !== "string" || !isId(s.uid)) return null;
    if (typeof s.exp !== "number" || !Number.isFinite(s.exp) || s.exp <= now)
      return null;
    return { uid: s.uid, exp: s.exp };
  } catch {
    return null;
  }
}

export function sessionCookie(value: string, env: Env): string {
  const secure = env.ENVIRONMENT === "dev" ? "" : " Secure;";
  return `oa_session=${value}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}`;
}

export function clearSessionCookie(env: Pick<Env, "ENVIRONMENT">): string {
  const secure = env.ENVIRONMENT === "dev" ? "" : " Secure;";
  return `oa_session=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`;
}
