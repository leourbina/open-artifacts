import { env } from "cloudflare:workers";
import { type Member, newId, R, viewerPath } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const mk = async (p: string, role: Member["role"] = "member") => {
  const l = await login(`${p}-${tag}@x.com`, role);
  const member = await getUser(env, l.userId);
  if (!member) throw new Error("no user");
  return { ...l, member };
};
const webp = (fill: number) => {
  const b = new Uint8Array(new ArrayBuffer(64)).fill(fill);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBP"), 8);
  return b;
};
const put = (id: string, cookie: string, body: Uint8Array<ArrayBuffer>) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.thumbnail(id)}`, {
      method: "PUT",
      headers: { cookie, "x-oa-request": "1", "content-type": "image/webp" },
      body,
    }),
  );

describe("B15 breakers", () => {
  it("token cap holds under concurrent creates", async () => {
    const u = await mk("bk-cap", "admin");
    await Promise.all(
      Array.from({ length: 60 }, () =>
        api(app, R.tokens, u.cookie, { method: "POST", body: { label: "x" } }),
      ),
    );
    const list = (await (
      await api(app, R.tokens, u.cookie)
    ).json()) as unknown[];
    expect(list.length).toBeLessThanOrEqual(50);
  });

  it("a viewer cannot overwrite via concurrent first uploads", async () => {
    const owner = await mk("bk-o");
    const id = (
      await publish(
        env,
        owner.member,
        {
          title: "t",
          format: "markdown",
          content: "x",
          visibility: "public",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const a = await mk("bk-va");
    const b = await mk("bk-vb");
    for (const u of [a, b])
      await api(app, R.shares(id), owner.cookie, {
        method: "PUT",
        body: { email: u.member.email, role: "viewer" },
      });
    const rs = await Promise.all([
      put(id, a.cookie, webp(1)),
      put(id, b.cookie, webp(2)),
    ]);
    expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
  });

  it("shell does not turn an ASSETS failure into 200", async () => {
    const owner = await mk("bk-s");
    const id = (
      await publish(
        env,
        owner.member,
        {
          title: "t",
          format: "markdown",
          content: "x",
          visibility: "public",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const assets = { fetch: async () => new Response("boom", { status: 500 }) };
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${viewerPath(id)}`),
      { ...(env as object), ASSETS: assets },
    );
    expect(r.status).not.toBe(200);
  });

  it("public-only viewer cannot upload a thumbnail", async () => {
    const owner = await mk("bk-po");
    const id = (
      await publish(
        env,
        owner.member,
        {
          title: "t",
          format: "markdown",
          content: "x",
          visibility: "public",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const v = await mk("bk-pv");
    expect((await put(id, v.cookie, webp(3))).status).toBe(404);
  });

  it("a PAT cannot mint PATs", async () => {
    const u = await mk("bk-pat");
    const t = (await (
      await api(app, R.tokens, u.cookie, {
        method: "POST",
        body: { label: "a" },
      })
    ).json()) as { token: string };
    const r = await api(app, R.tokens, t.token, {
      method: "POST",
      body: { label: "b" },
    });
    expect(r.status).toBe(404);
  });

  it("OG strips bidi/zero-width and truncates by code point", async () => {
    const owner = await mk("bk-og");
    const desc = "😀".repeat(400);
    const id = (
      await publish(
        env,
        owner.member,
        {
          title: "a\u202Eb\u200Bc",
          description: desc,
          format: "markdown",
          content: "x",
          visibility: "public",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const assets = {
      fetch: async () =>
        new Response("<html><head><title>x</title></head></html>", {
          headers: { "content-type": "text/html" },
        }),
    };
    const t = await (
      await fetchAndWait(
        app,
        new Request(`http://app.localhost${viewerPath(id)}`),
        { ...(env as object), ASSETS: assets },
      )
    ).text();
    expect(t).not.toMatch(/[\u202E\u200B]/);
    expect(t).toContain("abc");
    expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(t).toContain("😀".repeat(300) + '"');
  });
});
