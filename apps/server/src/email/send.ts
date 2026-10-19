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
export const EMAIL_TIMEOUT_MS = 3000;
const ALL_KEY = "email:*";

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

// Counts one email unless today's count is already at the cap (the row resets
// on a new day). RETURNING is empty when over the cap.
const TAKE = `insert into counters (key, n, day) values (?1, 1, ?2)
  on conflict (key) do update set
    n = case when counters.day = excluded.day then counters.n + 1 else 1 end,
    day = excluded.day
  where counters.day <> excluded.day or counters.n < ?3
  returning n`;

/** True if EMAIL and EMAIL_FROM are both configured. */
export const emailEnabled = (env: Env): boolean =>
  !!env.EMAIL && !!env.EMAIL_FROM;

/**
 * Takes a slot under both daily caps (one D1 batch). A send refused by one cap
 * may still use a slot of the other; that only errs towards sending less.
 */
async function takeSlot(env: Env, userId: string, now: number) {
  const day = utcDay(now);
  const [u, all] = await env.DB.batch<{ n: number }>([
    stmt(env.DB, TAKE).bind(
      `email:${userId}`,
      day,
      MAX_EMAILS_PER_USER_PER_DAY,
    ),
    stmt(env.DB, TAKE).bind(ALL_KEY, day, MAX_EMAILS_PER_DAY),
  ]);
  return !!u?.results.length && !!all?.results.length;
}

/**
 * Sends `render()` to the (already validated) address `to` on behalf of
 * `userId`. Rendering runs inside the guard, so a template error is `false`.
 */
export async function sendEmail(
  env: Env,
  userId: string,
  to: string,
  render: () => EmailContent,
  now = Date.now(),
): Promise<boolean> {
  const { EMAIL, EMAIL_FROM } = env;
  if (!EMAIL || !EMAIL_FROM) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = render();
    if (!(await takeSlot(env, userId, now))) return false;
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
