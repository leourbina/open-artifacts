import { ApiError } from "../http/errors.js";
import type { AuthConfig } from "./config.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 3000;
/** The widget action the sign-in page must pass for a code request. */
export const TURNSTILE_ACTION = "code_request";

/**
 * Turnstile siteverify for a code request. True only on success with
 * hostname `appHost` and action "code_request"; false on a missing token, a
 * refusal, a mismatch, a timeout or any error (fail closed). Never logs the
 * token.
 */
export async function verifyTurnstile(
  cfg: AuthConfig,
  token: string | undefined,
  ip: string | null,
  appHost: string,
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
    const out = (await res.json()) as {
      success?: unknown;
      hostname?: unknown;
      action?: unknown;
    };
    return (
      out.success === true &&
      out.hostname === appHost &&
      out.action === TURNSTILE_ACTION
    );
  } catch {
    return false;
  }
}

/**
 * The gate on EVERY code request while Turnstile is configured (no
 * exemptions): 400 turnstile_required without a token, 403 turnstile_failed
 * when siteverify refuses it. A no-op when Turnstile isn't configured.
 */
export async function requireTurnstile(
  cfg: AuthConfig,
  token: string | undefined,
  ip: string | null,
  appHost: string,
): Promise<void> {
  if (!cfg.turnstile) return;
  if (!token)
    throw new ApiError("turnstile_required", "Turnstile token required", {
      field: "turnstile",
      required: true,
    });
  if (!(await verifyTurnstile(cfg, token, ip, appHost)))
    throw new ApiError("turnstile_failed", "Turnstile check failed");
}
