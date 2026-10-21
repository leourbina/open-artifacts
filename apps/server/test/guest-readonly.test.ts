import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { accessLevel } from "../src/auth/authz.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { direct, uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

// P2 Task 9: guests are read-only under direct sign-in (and every code
// session outside the verified domains, whatever the env says).
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const SESSION = sessionCookieName(env);

const call = (
  e: Env,
  path: string,
  cookie: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) =>
  app.fetch(
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        cookie,
        "x-oa-request": "1",
        ...init.headers,
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    e,
    ctx,
  );

/** An artifact with the db + storage capabilities, shared with `email` as editor. */
async function sharedArtifact(email: string): Promise<string> {
  const o = await login(uniq("own"));
  const owner = await getUser(env, o.userId);
  const { id } = await publish(
    env,
    owner as never,
    {
      title: "t",
      format: "html",
      content: "<p>x</p>",
      capabilities: { db: true, storage: true, viewer: false },
    } as never,
    null,
    undefined,
    "create",
  );
  await env.DB.prepare(
    "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'editor', ?, ?)",
  )
    .bind(id, email, o.userId, Date.now())
    .run();
  return id;
}

/** A session cookie for `email` as `role`, signed the way `provider` would. */
async function sessionFor(
  email: string,
  role: "guest" | "member",
  provider: "access" | "code" = "access",
  tenant?: string,
) {
  const { userId } = await login(email, role);
  return `${SESSION}=${await signSession(env, userId, Date.now(), { provider, tenant })}`;
}

const WRITES = (id: string) =>
  [
    ["PATCH", R.artifact(id), { title: "x" }],
    ["DELETE", R.artifact(id), undefined],
    ["POST", R.versions(id), { format: "html", content: "<p>y</p>" }],
    ["PUT", R.shares(id), { email: "z@x.com", role: "viewer" }],
    ["PUT", R.dataDoc(id, "c", "d"), { v: 1 }],
    ["DELETE", R.dataDoc(id, "c", "d"), undefined],
    ["PUT", R.storageKey(id, "k"), { v: 1 }],
    ["POST", R.uploads, { path: "a.txt", size: 1, contentType: "text/plain" }],
  ] as const;

describe("guest read cap (direct sign-in)", () => {
  it("a guest with an editor share can read, but every write is refused", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    const e = direct();
    expect((await call(e, R.artifact(id), g)).status).toBe(200);
    for (const [method, path, body] of WRITES(id)) {
      const r = await call(e, path, g, { method, body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    const create = await call(e, R.artifacts, g, {
      method: "POST",
      body: { title: "n", format: "markdown", content: "x" },
    });
    expect(create.status).toBe(403);
    expect(
      ((await create.json()) as { error: { code: string } }).error.code,
    ).toBe("space_forbidden");
  });

  it("the artifact reads back as viewer for a capped guest", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const { userId } = await login(uniq("g2", "x.com"), "guest");
    await env.DB.prepare(
      "update shares set email = (select email from users where id = ?) where artifact_id = ?",
    )
      .bind(userId, id)
      .run();
    const user = await getUser(env, userId);
    const level = await accessLevel(
      env,
      { kind: "user", user: user as never, cap: "guest" },
      id,
    );
    expect(level?.level).toBe("viewer");
    const uncapped = await accessLevel(
      env,
      { kind: "user", user: user as never },
      id,
    );
    expect(uncapped?.level).toBe("editor");
  });

  it("the guest can still set their own display name", async () => {
    const g = await sessionFor(uniq("g", "x.com"), "guest");
    expect(
      (
        await call(direct(), R.me, g, {
          method: "PATCH",
          body: { displayName: "Gee" },
        })
      ).status,
    ).toBe(200);
  });

  it("H3: with AUTH_PROVIDERS=access,email a guest is capped", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    const e = { ...env, AUTH_PROVIDERS: "access,email" } as Env;
    expect(
      (
        await call(e, R.artifact(id), g, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(404);
  });

  it("H3: a code session outside the domains is capped even on an Access-only install", async () => {
    const email = uniq("m", "x.com");
    const id = await sharedArtifact(email);
    const c = await sessionFor(email, "member", "code");
    expect(
      (
        await call(env, R.artifact(id), c, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(404);
  });

  it("Access-only installs keep today's guest editor rights", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    expect(
      (
        await call(env, R.artifact(id), g, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(200);
  });

  it("a capped guest can open the live socket, and writes stay refused", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    const e = direct();
    const r = await call(e, R.dataSubscribe(id, "c"), g, {
      headers: { upgrade: "websocket" },
    });
    expect(r.status).toBe(101);
    r.webSocket?.accept();
    r.webSocket?.close();
    expect(
      (
        await call(e, R.dataDoc(id, "c", "d"), g, {
          method: "PUT",
          body: { v: 1 },
        })
      ).status,
    ).toBe(404);
  });

  it("members are untouched under direct sign-in", async () => {
    const email = uniq("m");
    const id = await sharedArtifact(email);
    const m = await sessionFor(email, "member", "access");
    expect(
      (
        await call(direct(), R.artifact(id), m, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(200);
  });
});
