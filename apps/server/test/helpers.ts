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
  if (!e) throw new Error(`invalid test email: ${email}`);
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

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** Calls the app with a session cookie (and the CSRF header) or anonymously. */
export function api(
  app: {
    fetch: (
      r: Request,
      e: typeof env,
      c: never,
    ) => Response | Promise<Response>;
  },
  path: string,
  auth: string | null,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "x-oa-request": "1",
    ...init.headers,
  };
  if (auth?.startsWith("oa_pat_")) headers.authorization = `Bearer ${auth}`;
  else if (auth) headers.cookie = auth;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(
    app.fetch(
      new Request(`http://app.localhost${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      env,
      ctx,
    ),
  );
}

export const errOf = async (r: Response) =>
  (
    (await r.json()) as {
      error: { code: string; message: string; details?: unknown };
    }
  ).error;
