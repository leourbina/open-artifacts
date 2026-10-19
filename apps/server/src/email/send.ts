import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import type { EmailContent } from "./templates.js";

// Optional notification email via a Cloudflare Email Service `send_email`
// binding (EMAIL) and sender (EMAIL_FROM). Best effort: never throws, and
// any missing config, cap or send failure is just `false`.

/** Emails one inviter may trigger per UTC day. */
export const MAX_EMAILS_PER_USER_PER_DAY = 20;
/** Emails per UTC day, instance-wide (protects the monthly sending quota). */
export const MAX_EMAILS_PER_DAY = 100;
/** Emails one recipient address may receive per UTC day, instance-wide. */
export const MAX_EMAILS_PER_RECIPIENT_PER_DAY = 5;
export const EMAIL_TIMEOUT_MS = 3000;
const ALL_KEY = "email:*";

// One plain addr-spec: no quotes, commas, semicolons, angle brackets, comments
// or whitespace, so the binding can never read `to` as a list or display name.
const SINGLE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

// Counts one email unless today's count is already at the cap (the row resets
// on a new day). RETURNING is empty when over the cap.
const TAKE = `insert into counters (key, n, day) values (?1, 1, ?2)
  on conflict (key) do update set
    n = case when counters.day = excluded.day then counters.n + 1 else 1 end,
    day = excluded.day
  where counters.day <> excluded.day or counters.n < ?3
  returning n`;

/** Daily cron: drops email counters from before today (they reset anyway). */
export async function sweepEmailCounters(env: Env, now = Date.now()) {
  await env.DB.prepare(
    "delete from counters where key like 'email:%' and day < ?",
  )
    .bind(utcDay(now))
    .run();
}

/** True if EMAIL and EMAIL_FROM are both configured. */
export const emailEnabled = (env: Env): boolean =>
  !!env.EMAIL && !!env.EMAIL_FROM;

/**
 * Takes a slot under every daily cap (one D1 batch, each an atomic conditional
 * upsert). A send refused by one cap may still use a slot of another; that
 * only errs towards sending less.
 */
async function takeSlot(
  env: Env,
  caps: [key: string, max: number][],
  now: number,
) {
  const day = utcDay(now);
  const rows = await env.DB.batch<{ n: number }>(
    caps.map(([key, max]) => stmt(env.DB, TAKE).bind(key, day, max)),
  );
  return rows.every((r) => r.results.length > 0);
}

/**
 * Sends `render()` to the (already validated) address `to` on behalf of
 * `userId`. Rendering runs inside the guard, so a template error is `false`.
 * With `artifactId`, one email per (artifact, recipient) per day, so removing
 * and re-adding a share can't re-mail.
 */
export async function sendEmail(
  env: Env,
  userId: string,
  to: string,
  render: () => EmailContent,
  opts: { artifactId?: string; now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const { EMAIL, EMAIL_FROM } = env;
  if (!EMAIL || !EMAIL_FROM || !SINGLE_ADDRESS.test(to)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = render();
    const caps: [string, number][] = [
      [`email:${userId}`, MAX_EMAILS_PER_USER_PER_DAY],
      [ALL_KEY, MAX_EMAILS_PER_DAY],
      [`email:to:${to}`, MAX_EMAILS_PER_RECIPIENT_PER_DAY],
    ];
    if (opts.artifactId) caps.push([`email:a:${opts.artifactId}:${to}`, 1]);
    if (!(await takeSlot(env, caps, now))) return false;
    // On timeout we report false, but delivery is only unconfirmed: the
    // email may still arrive.
    await Promise.race([
      EMAIL.send({ from: EMAIL_FROM, to, ...content }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("email timeout")),
          EMAIL_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
