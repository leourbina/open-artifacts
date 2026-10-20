import type { Env } from "../env.js";

/** Daily cron: drops expired sign-in codes (verify already refuses them). */
export async function sweepLoginCodes(env: Env, now = Date.now()) {
  await env.DB.prepare("delete from login_codes where expires_at < ?")
    .bind(now)
    .run();
}
