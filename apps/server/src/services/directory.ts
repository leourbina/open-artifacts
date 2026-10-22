import type { Member } from "@oa/shared";
import type { Env } from "../env.js";

/**
 * P3 seam: called after every successful Google admission, before the
 * session is issued (P3 diffs groups.list for this user). P2 lands the
 * signature; P3 owns the body. A throw is logged and never blocks sign-in.
 */
export async function onGoogleSignIn(_env: Env, _user: Member): Promise<void> {}
