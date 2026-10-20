import { CODE_POLICY } from "@oa/shared";
import { normEmail } from "../db/email.js";
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail, takeEach } from "../email/send.js";
import { loginCodeEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { codeEligibility } from "../services/identity.js";
import { getSettings } from "../services/members.js";
import { b64urlDecode, hmacSign } from "../util/crypto.js";
import type { AuthConfig } from "./config.js";
import { deriveKey, MIN_SECRET_LENGTH } from "./keys.js";

// Emailed one-time sign-in codes (P2). One row per request, keyed by HMACs
// (no plaintext email or code at rest), 8 digits, 10 minutes, 5 attempts per
// request enforced atomically in D1. Limits that count every well-formed
// address (enumeration resistance) run in the request; the pool and
// per-address send caps only on a real send.

/** Server-only limits; CODE_POLICY (length, TTL, resend, attempts) is #359's. */
export const CODE_LIMITS = {
  /** Requests per (address, IP) per 10 minutes: also the resend floor. */
  perEmailIpPer10Min: 3,
  /** Requests per address per hour: logged as code_abuse at this count. */
  perEmailPerHourAlert: 10,
  /** Requests per address per hour, across IPs. */
  perEmailPerHour: 30,
  /** Real sends per address per hour. */
  sendsPerEmailPerHour: 5,
  /** Requests per IP per UTC day. */
  perIpPerDay: 50,
  /** Failed verifications per IP per hour. */
  failsPerIpPerHour: 30,
} as const;

const TTL_MS = CODE_POLICY.ttlSec * 1000;
const MAX_U32_UNBIASED = 4_200_000_000; // largest multiple of 10^8 below 2^32
// Compared when no row matched, so the work is the same either way.
const DUMMY_HASH = "A".repeat(43);

type BucketKind = "day" | "hour" | "tenMin";

/** The counters.day bucket for `now` (UTC): "YYYY-MM-DD", "…THH", "…THH:M". */
export function counterBucket(kind: BucketKind, now: number): string {
  const iso = new Date(now).toISOString();
  if (kind === "day") return iso.slice(0, 10);
  if (kind === "hour") return iso.slice(0, 13);
  return iso.slice(0, 15); // tens of minutes
}

const BUCKET_MS: Record<BucketKind, number> = {
  day: 86_400_000,
  hour: 3_600_000,
  tenMin: 600_000,
};
const retryAfter = (kind: BucketKind, now: number) =>
  Math.max(1, Math.ceil((BUCKET_MS[kind] - (now % BUCKET_MS[kind])) / 1000));

/**
 * The code keys, or 503 `code_unavailable` when the install's SESSION_SECRET
 * is under 32 characters: HKDF can't key the codes then (the raw secret only
 * keeps old session and state cookies readable), so codes are switched off
 * rather than failing with a 500 on every request.
 */
export async function codesKey(
  env: Env,
  label: "oa:login-codes" | "oa:code-cookie",
): Promise<string> {
  const s = env.SESSION_SECRET;
  if (typeof s !== "string" || s.length < MIN_SECRET_LENGTH)
    throw new ApiError(
      "code_unavailable",
      "Code sign-in is unavailable on this install",
    );
  return deriveKey(env, label);
}

/** HMAC of the normalized address: the row key and the counter key part. */
export async function emailKey(env: Env, email: string): Promise<string> {
  const e = normEmail(email) ?? email.trim().toLowerCase();
  return hmacSign(await codesKey(env, "oa:login-codes"), `email:${e}`);
}

/** HMAC of the client IP, shortened: counter keys never hold the IP either. */
export async function ipKey(env: Env, ip: string): Promise<string> {
  return (
    await hmacSign(await codesKey(env, "oa:login-codes"), `ip:${ip}`)
  ).slice(0, 22);
}

/** Constant-time equality of two HMACs (both 32 bytes). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const codeHash = async (env: Env, ek: string, rid: string, code: string) =>
  hmacSign(await codesKey(env, "oa:login-codes"), `${ek}:${rid}:${code}`);

function randomCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const n = buf[0] as number;
    if (n < MAX_U32_UNBIASED)
      return String(n % 100_000_000).padStart(CODE_POLICY.length, "0");
  }
}

/**
 * Request limits that count every well-formed address, eligible or not, so a
 * 429 says nothing about who can sign in: per (address, IP) per 10 minutes,
 * per address per hour (code_abuse logged at the alert count), per IP per
 * day. (address, IP) refusals report scope "email" (#359).
 */
export async function takeRequestSlot(
  env: Env,
  _cfg: AuthConfig,
  ek: string,
  ik: string,
  now = Date.now(),
): Promise<
  { ok: true } | { ok: false; retryAfter: number; scope: "ip" | "email" }
> {
  const [ipOk, eipOk, eOk] = await takeEach(env, [
    [`code:ip:${ik}`, CODE_LIMITS.perIpPerDay, counterBucket("day", now)],
    [
      `code:eip:${ek}:${ik}`,
      CODE_LIMITS.perEmailIpPer10Min,
      counterBucket("tenMin", now),
    ],
    [`code:e:${ek}`, CODE_LIMITS.perEmailPerHour, counterBucket("hour", now)],
  ]);
  if (!ipOk)
    return { ok: false, retryAfter: retryAfter("day", now), scope: "ip" };
  if (!eipOk)
    return { ok: false, retryAfter: retryAfter("tenMin", now), scope: "email" };
  if (!eOk)
    return { ok: false, retryAfter: retryAfter("hour", now), scope: "email" };
  const n = await stmt(env.DB, "select n from counters where key = ?1")
    .bind(`code:e:${ek}`)
    .first<{ n: number }>();
  if (n?.n === CODE_LIMITS.perEmailPerHourAlert)
    console.warn(JSON.stringify({ evt: "code_abuse", scope: "email" }));
  return { ok: true };
}

/** Stores a new code for (ek, rid) and returns it. `gen` is for tests only. */
export async function createCode(
  env: Env,
  ek: string,
  rid: string,
  now = Date.now(),
  gen: () => string = randomCode,
): Promise<string> {
  const code = gen();
  await stmt(
    env.DB,
    "insert into login_codes (email_key, request_id, code_hash, expires_at, created_at) values (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(ek, rid, await codeHash(env, ek, rid, code), now + TTL_MS, now)
    .run();
  return code;
}

const logSend = (outcome: string) =>
  console.log(JSON.stringify({ evt: "code_send", outcome }));

/**
 * The real send, after the response (waitUntil): eligibility, then the
 * per-address send cap and the code pool (taken in that order, only now),
 * then the row and the email. Null when nothing was sent; a failed send
 * deletes its row.
 */
export async function deliverCode(
  env: Env,
  cfg: AuthConfig,
  email: string,
  ek: string,
  requestId: string,
  now = Date.now(),
): Promise<{ requestId: string } | null> {
  if (!emailEnabled(env)) return logSend("email_off"), null;
  const to = normEmail(email);
  if (!to) return logSend("ineligible"), null;
  if ((await codeEligibility(env, cfg, to)).kind === "none")
    return logSend("ineligible"), null;
  const [perAddress] = await takeEach(env, [
    [
      `code:sent:${ek}`,
      CODE_LIMITS.sendsPerEmailPerHour,
      counterBucket("hour", now),
    ],
  ]);
  if (!perAddress) return logSend("capped"), null;
  const [pool] = await takeEach(env, [
    ["code:*", cfg.codeEmailsPerDay, counterBucket("day", now)],
  ]);
  if (!pool) return logSend("pool_full"), null;
  const code = await createCode(env, ek, requestId, now);
  const instance =
    (await getSettings(env).catch(() => null))?.name ?? "Open Artifacts";
  const sent = await sendEmail(
    env,
    null,
    to,
    () =>
      loginCodeEmail({
        code,
        instance,
        appHost: env.APP_HOST,
        minutes: CODE_POLICY.ttlSec / 60,
      }),
    { kind: "code", now, caps: [] },
  );
  if (!sent) {
    await stmt(
      env.DB,
      "delete from login_codes where email_key = ?1 and request_id = ?2",
    )
      .bind(ek, requestId)
      .run();
    return logSend("send_failed"), null;
  }
  return { requestId };
}

/**
 * Checks a code. Pinned order, the same statements whether or not a row
 * exists:
 * 1. Normalize: strip whitespace and hyphens; well-formed = exactly 8 digits.
 * 2. Reserve a per-IP failure slot atomically (none left: ipLocked).
 * 3. UPDATE … attempts = attempts + 1 WHERE … attempts < 5 AND unexpired
 *    RETURNING code_hash: atomic, so at most 5 guesses ever see the hash.
 * 4. HMAC the input and compare in constant time (against a dummy when no
 *    row came back, so the work is the same).
 * 5. One batch: consume the row (DELETE … AND code_hash = the compared hash;
 *    a guard, user input never meets code_hash in SQL) and refund the
 *    failure slot on success.
 * The result carries no reason, so an address that never got a code looks
 * like a wrong guess; the route words it from its signed cookie.
 */
export async function verifyCode(
  env: Env,
  _cfg: AuthConfig,
  p: {
    email: string;
    requestId: string;
    input: string;
    ip: string;
    now?: number;
  },
): Promise<{ ok: true } | { ok: false } | { ok: false; ipLocked: number }> {
  const now = p.now ?? Date.now();
  const norm = p.input.replace(/[\s-]/g, "");
  const wellFormed = /^[0-9]{8}$/.test(norm);
  const ek = await emailKey(env, p.email);
  const ik = await ipKey(env, p.ip);
  const failKey = `code:fail:${ik}`;
  const hour = counterBucket("hour", now);

  const [slot] = await takeEach(env, [
    [failKey, CODE_LIMITS.failsPerIpPerHour, hour],
  ]);
  if (!slot) return { ok: false, ipLocked: retryAfter("hour", now) };

  const row = await stmt(
    env.DB,
    `update login_codes set attempts = attempts + 1
     where email_key = ?1 and request_id = ?2 and attempts < ?3 and expires_at > ?4
     returning code_hash`,
  )
    .bind(ek, p.requestId, CODE_POLICY.maxAttempts, now)
    .first<{ code_hash: string }>();

  const candidate = await codeHash(
    env,
    ek,
    p.requestId,
    wellFormed ? norm : "x",
  );
  const stored = row?.code_hash ?? DUMMY_HASH;
  const a = b64urlDecode(candidate) ?? new Uint8Array(32);
  const b = b64urlDecode(stored) ?? new Uint8Array(32);
  const same = sameBytes(a, b);
  const match = row !== null && wellFormed && same;

  const [del] = await env.DB.batch<{ x: number }>([
    stmt(
      env.DB,
      "delete from login_codes where email_key = ?1 and request_id = ?2 and code_hash = ?3 returning 1 as x",
    ).bind(ek, p.requestId, match ? stored : "!"),
    stmt(
      env.DB,
      "update counters set n = n - 1 where key = ?1 and day = ?2 and ?3 = 1 and n > 0",
    ).bind(failKey, hour, match ? 1 : 0),
  ]);
  return match && (del?.results.length ?? 0) > 0 ? { ok: true } : { ok: false };
}

/** Daily cron: drops expired sign-in codes (verify already refuses them). */
export async function sweepLoginCodes(env: Env, now = Date.now()) {
  await env.DB.prepare("delete from login_codes where expires_at < ?")
    .bind(now)
    .run();
}
