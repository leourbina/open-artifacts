import { env } from "cloudflare:workers";
import {
  LIMITS,
  type Member,
  newId,
  R,
  TokenCreatedSchema,
  TokenSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member };
const mk = async (p: string, role: Member["role"]): Promise<U> => {
  const l = await login(`${p}-${tag}@x.com`, role);
  const member = await getUser(env, l.userId);
  if (!member) throw new Error("no user");
  return { ...l, member };
};
const create = (u: U, label = "cli") =>
  api(app, R.tokens, u.cookie, { method: "POST", body: { label } });

let member: U;
let other: U;
beforeAll(async () => {
  member = await mk("tk-m", "member");
  other = await mk("tk-o", "member");
});

describe("tokens", () => {
  it("create returns the secret once; works on /me; delete revokes", async () => {
    const r = await create(member);
    expect(r.status).toBe(201);
    const t = TokenCreatedSchema.parse(await r.json());
    expect(t.token).toMatch(/^oa_pat_/);
    expect((await api(app, R.me, t.token)).status).toBe(200);
    const list = await api(app, R.tokens, member.cookie);
    const text = await list.text();
    expect(text).not.toContain(t.token);
    expect(text).not.toMatch(/hash/i);
    const toks = (JSON.parse(text) as unknown[]).map((x) =>
      TokenSchema.parse(x),
    );
    expect(toks.map((x) => x.id)).toContain(t.id);
    expect(
      (await api(app, R.token(t.id), member.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect((await api(app, R.me, t.token)).status).toBe(401);
    const after = (await (await api(app, R.tokens, member.cookie)).json()) as {
      id: string;
    }[];
    expect(after.map((x) => x.id)).not.toContain(t.id);
  });

  it("cannot delete someone else's token (404)", async () => {
    const t = TokenCreatedSchema.parse(await (await create(other)).json());
    const r = await api(app, R.token(t.id), member.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(404);
    expect((await api(app, R.me, t.token)).status).toBe(200);
  });

  it("guests get 404 on POST; strict body; unauth 401", async () => {
    const g = await mk("tk-g", "guest");
    expect((await create(g)).status).toBe(404);
    const bad = await api(app, R.tokens, member.cookie, {
      method: "POST",
      body: { label: "x", extra: 1 },
    });
    expect(bad.status).toBe(400);
    expect((await api(app, R.tokens, null)).status).toBe(401);
  });

  it("caps active tokens at 50", async () => {
    const u = await mk("tk-cap", "admin");
    for (let i = 0; i < 50; i++) expect((await create(u)).status).toBe(201);
    const r = await create(u);
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("bad_request");
  });
});

describe("thumbnail PUT", () => {
  const webp = (n = 32) => {
    const b = new Uint8Array(new ArrayBuffer(n));
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WEBP"), 8);
    return b;
  };
  const raw = (
    id: string,
    u: U,
    body: Uint8Array<ArrayBuffer>,
    ct = "image/webp",
  ) =>
    import("./helpers.js").then(({ fetchAndWait }) =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${R.thumbnail(id)}`, {
          method: "PUT",
          headers: {
            cookie: u.cookie,
            "x-oa-request": "1",
            "content-type": ct,
          },
          body,
        }),
      ),
    );
  const mkArt = async (owner: U) =>
    (
      await publish(
        env,
        owner.member,
        { title: "t", format: "markdown", content: "x" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
  const share = (id: string, owner: U, email: string, role: string) =>
    api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email, role },
    });

  it("owner uploads, replaces; validates type, magic, size", async () => {
    const id = await mkArt(member);
    expect((await raw(id, member, webp(), "image/png")).status).toBe(400);
    expect((await raw(id, member, new Uint8Array(32))).status).toBe(400);
    expect(
      (await raw(id, member, webp(LIMITS.thumbnailBytes + 1))).status,
    ).toBe(413);
    expect((await raw(id, member, webp())).status).toBe(204);
    expect((await raw(id, member, webp(40))).status).toBe(204);
    const g = await api(app, R.thumbnail(id), member.cookie);
    expect(g.status).toBe(200);
    expect((await g.arrayBuffer()).byteLength).toBe(40);
  });

  it("viewer only when none exists; editor always; others 404", async () => {
    const id = await mkArt(member);
    const viewer = await mk("tk-v", "member");
    const email = (await getUser(env, viewer.userId))?.email ?? "";
    await share(id, member, email, "viewer");
    expect((await raw(id, other, webp())).status).toBe(404);
    expect((await raw(id, viewer, webp())).status).toBe(204);
    expect((await raw(id, viewer, webp())).status).toBe(404);
    await share(id, member, email, "editor");
    expect((await raw(id, viewer, webp())).status).toBe(204);
  });

  it("CSRF applies to cookie PUT", async () => {
    const id = await mkArt(member);
    const { fetchAndWait } = await import("./helpers.js");
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.thumbnail(id)}`, {
        method: "PUT",
        headers: { cookie: member.cookie, "content-type": "image/webp" },
        body: webp(),
      }),
    );
    expect(r.status).toBe(403);
  });
});
