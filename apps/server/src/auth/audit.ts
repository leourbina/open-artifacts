import type { SessionProvider } from "./session.js";

/**
 * One structured line per sign-in outcome (Workers Logs). Never an email,
 * code, token, state, nonce or key: only enums, the user id and the verified
 * tenant. The audit log (P3/M4) adds a D1 sink behind this call.
 */
export type AuthEvent = {
  evt: "auth";
  provider: SessionProvider;
  outcome: "ok" | "refused" | "error";
  /** Why, for refusals and errors: a fixed stage or SignInError. */
  stage?: string;
  uid?: string;
  tenant?: string;
};

export function logAuth(e: Omit<AuthEvent, "evt">): void {
  console.log(JSON.stringify({ evt: "auth", ...e } satisfies AuthEvent));
}
