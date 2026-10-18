import { env } from "cloudflare:workers";
import { type Member, newId, R, VERSIONS_PAGE_SIZE } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let o: { cookie: string; member: Member };
beforeAll(async () => {
  const l = await login(`brk-${tag}@x.com`);
  o = { cookie: l.cookie, member: (await getUser(env, l.userId)) as Member };
});

describe("B7 breaker", () => {
  it("restore keeps the artifact's format (markdown with a .txt entry)", async () => {
    const a = await publish(
      env,
      o.member,
      {
        title: "m",
        format: "markdown",
        files: { "notes.txt": "# hi" },
        entry: "notes.txt",
      } as never,
      null,
    );
    const r = await api(app, R.restoreVersion(a.id, 1), o.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(201);
    const s = (await (await api(app, R.artifact(a.id), o.cookie)).json()) as {
      format: string;
    };
    expect(s.format).toBe("markdown");
  });

  it("anonymous viewers of a public artifact don't get member emails", async () => {
    const a = await publish(
      env,
      o.member,
      {
        title: "p",
        format: "markdown",
        content: "x",
        visibility: "public",
      } as never,
      null,
    );
    const s = await (await api(app, R.artifact(a.id), null)).text();
    const v = await (await api(app, R.versions(a.id), null)).text();
    expect(s).not.toContain(`brk-${tag}@x.com`);
    expect(v).not.toContain(`brk-${tag}@x.com`);
  });

  it("versions list stays under 2 MB parsed for 1000-file versions", async () => {
    const a = await publish(
      env,
      o.member,
      { title: "big", format: "markdown", content: "x" } as never,
      null,
    );
    const man = JSON.stringify(
      Array.from({ length: 1000 }, (_, i) => ({
        path: `dir/file-${i}.txt`,
        key: `files/${a.id}/${newId()}`,
        size: 1,
        contentType: "text/plain",
      })),
    );
    const ins = [];
    for (let v = 2; v <= 40; v++)
      ins.push(
        env.DB.prepare(`insert into versions (artifact_id, version, entry, manifest, created_by, created_at)
        values (?, ?, 'README.md', ?, ?, ?)`).bind(
          a.id,
          v,
          man,
          o.member.id,
          Date.now(),
        ),
      );
    await env.DB.batch(ins);
    const r = await api(app, R.versions(a.id), o.cookie);
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBeLessThan(2 * 1024 * 1024);
  });

  it("keyset is stable with equal updated_at", async () => {
    const l = await login(`ks-${tag}@x.com`);
    const m = (await getUser(env, l.userId)) as Member;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(
        (
          await publish(
            env,
            m,
            { title: `k${i}`, format: "markdown", content: "x" } as never,
            null,
          )
        ).id,
      );
    await env.DB.prepare(
      "update artifacts set updated_at = 1000 where owner_id = ?",
    )
      .bind(m.id)
      .run();
    const seen: string[] = [];
    let cur: string | null = "";
    while (cur !== null) {
      const res = await api(
        app,
        `${R.artifacts}?scope=mine&limit=2${cur ? `&cursor=${cur}` : ""}`,
        l.cookie,
      );
      const p = (await res.json()) as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...p.items.map((x) => x.id));
      cur = p.nextCursor;
    }
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("restore/thumbnail/versions/file on a soft-deleted artifact → 404", async () => {
    const a = await publish(
      env,
      o.member,
      { title: "d", format: "markdown", content: "x" } as never,
      null,
    );
    await api(app, R.artifact(a.id), o.cookie, { method: "DELETE" });
    for (const [p, m] of [
      [R.restoreVersion(a.id, 1), "POST"],
      [R.versions(a.id), "GET"],
      [R.versionFile(a.id, 1, "README.md"), "GET"],
      [R.thumbnail(a.id), "GET"],
      [R.artifact(a.id), "PATCH"],
    ] as const)
      expect(
        (
          await api(app, p, o.cookie, {
            method: m,
            body: m === "PATCH" ? { title: "z" } : undefined,
          })
        ).status,
      ).toBe(404);
  });
});

describe("B7 fix round 1", () => {
  it("versions: newest 20, ?before keyset, non-integer before → 400", async () => {
    const a = await publish(
      env,
      o.member,
      { title: "many", format: "markdown", content: "x" } as never,
      null,
    );
    for (let i = 0; i < 24; i++)
      await publish(
        env,
        o.member,
        { id: a.id, format: "markdown", content: `v${i}` } as never,
        null,
      );
    const get = async (path: string) => {
      const r = await api(app, path, o.cookie);
      return {
        status: r.status,
        vs:
          r.status === 200
            ? ((await r.json()) as { version: number }[]).map((v) => v.version)
            : [],
      };
    };
    const p1 = await get(R.versions(a.id));
    expect(p1.vs).toEqual(
      Array.from({ length: VERSIONS_PAGE_SIZE }, (_, i) => 25 - i),
    );
    expect((await get(R.versions(a.id, 6))).vs).toEqual([5, 4, 3, 2, 1]);
    // Invalid values can't be built with R.versions (it throws), so raw strings.
    for (const b of ["x", "1.5", "-1", "0", ""])
      expect((await get(`${R.versions(a.id)}?before=${b}`)).status).toBe(400);
  });

  it("anonymous: summary owner email and versions createdBy email are null", async () => {
    const a = await publish(
      env,
      o.member,
      {
        title: "p2",
        format: "markdown",
        content: "x",
        visibility: "public",
      } as never,
      null,
    );
    const s = (await (await api(app, R.artifact(a.id), null)).json()) as {
      owner: { email: unknown };
    };
    expect(s.owner.email).toBeNull();
    const v = (await (await api(app, R.versions(a.id), null)).json()) as {
      createdBy: { email: unknown };
    }[];
    expect(v[0]?.createdBy.email).toBeNull();
    const signed = (await (
      await api(app, R.artifact(a.id), o.cookie)
    ).json()) as { owner: { email: unknown } };
    expect(signed.owner.email).toBe(`brk-${tag}@x.com`);
  });

  it("q is trimmed and capped at 40 chars", async () => {
    await publish(
      env,
      o.member,
      { title: "Qtrim target", format: "markdown", content: "x" } as never,
      null,
    );
    const r = await api(
      app,
      `${R.artifacts}?scope=mine&q=${encodeURIComponent("  qtrim  ")}`,
      o.cookie,
    );
    expect(((await r.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(
      (await api(app, `${R.artifacts}?q=${"a".repeat(40)}`, o.cookie)).status,
    ).toBe(200);
    expect(
      (await api(app, `${R.artifacts}?q=${"a".repeat(41)}`, o.cookie)).status,
    ).toBe(400);
  });

  it("PATCH body over the cap → 413", async () => {
    const a = await publish(
      env,
      o.member,
      { title: "cap", format: "markdown", content: "x" } as never,
      null,
    );
    const r = await api(app, R.artifact(a.id), o.cookie, {
      method: "PATCH",
      body: { description: "x".repeat(200 * 1024) },
    });
    expect(r.status).toBe(413);
  });
});
