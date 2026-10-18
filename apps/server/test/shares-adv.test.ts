import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; userId: string; member: Member; email: string };
beforeAll(async () => {
  const email = `adv-owner-${tag}@x.com`;
  const l = await login(email);
  owner = { ...l, member: (await getUser(env, l.userId))!, email };
});
const pub = async () =>
  (
    await publish(
      env,
      owner.member,
      { title: "t", format: "markdown", content: "h" } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const put = (id: string, email: string) =>
  api(app, R.shares(id), owner.cookie, {
    method: "PUT",
    body: { email, role: "viewer" },
  });
const list = async (id: string) =>
  (await (await api(app, R.shares(id), owner.cookie)).json()) as {
    email: string;
  }[];

describe("B9 adversarial", () => {
  it("share whose email contains % can be deleted via R.share", async () => {
    const id = await pub();
    const e = `a%41-${tag}@x.com`;
    const r = await put(id, e);
    if (r.status !== 200) return; // rejected up front is also acceptable
    const d = await api(app, R.share(id, e), owner.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
  });
  it("double-encoded path does not delete a different share", async () => {
    const id = await pub();
    await put(id, `dd-${tag}@x.com`);
    const d = await api(
      app,
      `${R.shares(id)}/dd-${tag}%2540x.com`,
      owner.cookie,
      { method: "DELETE" },
    );
    expect(d.status).toBe(404);
  });
  it("email with / round-trips", async () => {
    const id = await pub();
    const e = `a/b-${tag}@x.com`;
    if ((await put(id, e)).status !== 200) return;
    expect(
      (await api(app, R.share(id, e), owner.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });
  it("%00 / trailing dot / whitespace owner variants", async () => {
    const id = await pub();
    expect(
      (
        await api(app, `${R.shares(id)}/a%00@x.com`, owner.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBeLessThan(500);
    expect((await put(id, `${owner.email}.`)).status).toBe(400);
    expect((await put(id, ` ${owner.email.toUpperCase()} `)).status).toBe(400);
    expect(await list(id)).toHaveLength(0);
  });
  it("cap race: concurrent PUTs at 199 must not exceed 200", async () => {
    const id = await pub();
    const stmts = Array.from({ length: 199 }, (_, i) =>
      env.DB.prepare(
        "insert into shares (artifact_id,email,role,created_by,created_at) values (?,?,?,?,?)",
      ).bind(id, `c${i}-${tag}@x.com`, "viewer", owner.userId, Date.now() + i),
    );
    await env.DB.batch(stmts);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => put(id, `race${i}-${tag}@x.com`)),
    );
    const n = (await env.DB.prepare(
      "select count(*) n from shares where artifact_id=?",
    )
      .bind(id)
      .first<{ n: number }>())!.n;
    expect(n).toBeLessThanOrEqual(200);
  });
  it("deleted artifact: shares 404 for owner", async () => {
    const id = await pub();
    await env.DB.prepare("update artifacts set deleted_at=? where id=?")
      .bind(Date.now(), id)
      .run();
    expect((await put(id, `z-${tag}@x.com`)).status).toBe(404);
    expect((await api(app, R.shares(id), owner.cookie)).status).toBe(404);
  });
  it("CSRF: cookie PUT/DELETE without header -> 403 csrf", async () => {
    const id = await pub();
    for (const method of ["PUT", "DELETE"]) {
      const r = await app.fetch(
        new Request(
          `http://app.localhost${method === "PUT" ? R.shares(id) : R.share(id, "z@x.com")}`,
          {
            method,
            headers: {
              cookie: owner.cookie,
              "content-type": "application/json",
            },
            body:
              method === "PUT"
                ? JSON.stringify({ email: "z@x.com", role: "viewer" })
                : undefined,
          },
        ),
        env,
        { waitUntil() {}, passThroughOnException() {} } as never,
      );
      expect(r.status).toBe(403);
    }
  });
});
