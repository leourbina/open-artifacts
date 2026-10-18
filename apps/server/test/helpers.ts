import { env } from "cloudflare:workers";
import { newId, type Role } from "@oa/shared";
import { signSession } from "../src/auth/session.js";
import { getDb } from "../src/db/client.js";
import { normEmail } from "../src/db/email.js";
import { users } from "../src/db/schema.js";

/** Inserts the user and mints a session cookie for them. */
export async function login(
  email: string,
  role: Role = "member",
): Promise<{ cookie: string; userId: string }> {
  const userId = newId();
  const e = normEmail(email);
  await getDb(env)
    .insert(users)
    .values({
      id: userId,
      email: e,
      name: e.split("@")[0] ?? e,
      role,
      createdAt: Date.now(),
    });
  return { cookie: `oa_session=${await signSession(env, userId)}`, userId };
}
