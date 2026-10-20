import type { AuthConfig } from "./config.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 3000;

/**
 * Turnstile siteverify for a code request. False on a missing token, a
 * refusal, a timeout or any error (fail closed); never logs the token.
 */
export async function verifyTurnstile(
  cfg: AuthConfig,
  token: string | undefined,
  ip: string | null,
): Promise<boolean> {
  if (!cfg.turnstile || !token) return false;
  const body = new URLSearchParams({
    secret: cfg.turnstile.secret,
    response: token,
  });
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const out = (await res.json()) as { success?: unknown };
    return out.success === true;
  } catch {
    return false;
  }
}
