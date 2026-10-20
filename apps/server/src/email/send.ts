import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { sha256Hex } from "../util/crypto.js";
import type { EmailContent } from "./templates.js";

// Optional notification email via a Cloudflare Email Service `send_email`
// binding (EMAIL) and sender (EMAIL_FROM). Best effort: never throws, and
// any missing config, cap or send failure is just `false`.

/** Emails one inviter may trigger per UTC day. */
export const MAX_EMAILS_PER_USER_PER_DAY = 20;
/**
 * Invite and share emails per UTC day, instance-wide (protects the monthly
 * sending quota): EMAIL_DAILY_CAP, else this. Sign-in codes have their own
 * pool (auth/codes.ts), so invites can't starve sign-in.
 */
export const MAX_EMAILS_PER_DAY = 100;
const EMAIL_DAILY_CAP_MAX = 100_000;

export function emailDailyCap(env: Pick<Env, "EMAIL_DAILY_CAP">): number {
  const v = env.EMAIL_DAILY_CAP;
  if (!v || !/^[1-9]\d*$/.test(v)) return MAX_EMAILS_PER_DAY;
  const n = Number(v);
  return n <= EMAIL_DAILY_CAP_MAX ? n : MAX_EMAILS_PER_DAY;
}
/** Emails one recipient address may receive per UTC day, instance-wide. */
export const MAX_EMAILS_PER_RECIPIENT_PER_DAY = 5;
export const EMAIL_TIMEOUT_MS = 3000;
const ALL_KEY = "email:*";

// One plain addr-spec: no quotes, commas, semicolons, angle brackets, comments
// or whitespace, so the binding can never read `to` as a list or display name.
const SINGLE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;

/** Sender display name, the same on every email. */
const FROM_NAME = "Open Artifacts";

export type EmailKind = "invite" | "share" | "code";
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

class EmailTimeout extends Error {}

/** A short code for logs; never the message, which may name the recipient. */
function failReason(e: unknown): string {
  if (e instanceof EmailTimeout) return "timeout";
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE.test(code)
    ? code
    : "send_error";
}

// Structured logs carry the kind and messageId or reason only: never the
// recipient, sender, subject or body.
const logFailed = (kind: EmailKind, reason: string) =>
  console.warn(JSON.stringify({ evt: "email_failed", kind, reason }));

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

// Counts one unless the bucket's count is already at the cap (the row resets
// when the bucket changes: a UTC day here, finer for sign-in codes). RETURNING
// is empty when over the cap.
const TAKE = `insert into counters (key, n, day) values (?1, 1, ?2)
  on conflict (key) do update set
    n = case when counters.day = excluded.day then counters.n + 1 else 1 end,
    day = excluded.day
  where counters.day <> excluded.day or counters.n < ?3
  returning n`;

/** Daily cron: drops email and sign-in-code counters from before today (they reset anyway). */
export async function sweepEmailCounters(env: Env, now = Date.now()) {
  await env.DB.prepare(
    "delete from counters where (key like 'email:%' or key like 'code:%') and day < ?",
  )
    .bind(utcDay(now))
    .run();
}

/** A counter cap: key, max, and the bucket it counts in (a day, an hour, …). */
export type Cap = [key: string, max: number, bucket: string];

/**
 * Takes one slot under each cap, in one D1 batch (each an atomic conditional
 * upsert); true per cap that had room. A refused cap's siblings still count.
 */
export async function takeEach(env: Env, caps: Cap[]): Promise<boolean[]> {
  if (caps.length === 0) return [];
  const rows = await env.DB.batch<{ n: number }>(
    caps.map(([key, max, bucket]) => stmt(env.DB, TAKE).bind(key, bucket, max)),
  );
  return rows.map((r) => r.results.length > 0);
}

/** True if EMAIL and EMAIL_FROM are both configured. */
export const emailEnabled = (env: Env): boolean =>
  !!env.EMAIL && !!env.EMAIL_FROM;

/**
 * Takes a slot under every daily cap (one D1 batch, each an atomic conditional
 * upsert). A send refused by one cap may still use a slot of another; that
 * only errs towards sending less.
 */
async function takeSlot(env: Env, caps: Cap[]) {
  return (await takeEach(env, caps)).every(Boolean);
}

/**
 * Sends `render()` to the (already validated) address `to` on behalf of
 * `userId`. Rendering runs inside the guard, so a template error is `false`.
 * With `artifactId`, one email per (artifact, recipient) per day, so removing
 * and re-adding a share can't re-mail. Counter keys never hold the address
 * (a SHA-256 hex stands in). Sign-in codes pass `caps: []`: auth/codes.ts
 * takes their own pool's slots first.
 */
export async function sendEmail(
  env: Env,
  userId: string | null,
  to: string,
  render: () => EmailContent,
  opts: {
    kind: EmailKind;
    artifactId?: string;
    /** The inviter's/sharer's address; dropped unless one plain address. */
    replyTo?: string;
    now?: number;
    /** Replaces the invite/share caps (sign-in codes). */
    caps?: Cap[];
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const { EMAIL, EMAIL_FROM } = env;
  if (!EMAIL || !EMAIL_FROM || !SINGLE_ADDRESS.test(to)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let content: EmailContent;
  try {
    content = render();
  } catch {
    logFailed(opts.kind, "render");
    return false;
  }
  try {
    let caps = opts.caps;
    if (!caps) {
      const day = utcDay(now);
      const toKey = await sha256Hex(to.toLowerCase());
      caps = [
        [ALL_KEY, emailDailyCap(env), day],
        [`email:to:${toKey}`, MAX_EMAILS_PER_RECIPIENT_PER_DAY, day],
      ];
      if (userId)
        caps.push([`email:${userId}`, MAX_EMAILS_PER_USER_PER_DAY, day]);
      if (opts.artifactId)
        caps.push([`email:a:${opts.artifactId}:${toKey}`, 1, day]);
    }
    if (!(await takeSlot(env, caps))) {
      logFailed(opts.kind, "rate_limited");
      return false;
    }
    // On timeout we report false, but delivery is only unconfirmed: the
    // email may still arrive.
    const { messageId } = await Promise.race([
      EMAIL.send({
        // A plain address gets the product as its display name; anything
        // else is passed through as configured.
        from: SINGLE_ADDRESS.test(EMAIL_FROM)
          ? { email: EMAIL_FROM, name: FROM_NAME }
          : EMAIL_FROM,
        to,
        ...(opts.replyTo && SINGLE_ADDRESS.test(opts.replyTo)
          ? { replyTo: opts.replyTo }
          : {}),
        ...content,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EmailTimeout()), EMAIL_TIMEOUT_MS);
      }),
    ]);
    console.log(
      JSON.stringify({ evt: "email_sent", kind: opts.kind, messageId }),
    );
    return true;
  } catch (e) {
    logFailed(opts.kind, failReason(e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}
