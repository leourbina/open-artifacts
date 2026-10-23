import { env } from "cloudflare:workers";
import { normalizeEmail } from "@oa/auth-core";
import { type Member, newId, PageSchema, R, SearchHitSchema } from "@oa/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getDb } from "../src/db/client.js";
import { artifacts, shares, spaceMembers, spaces } from "../src/db/schema.js";
import { publish, softDelete, undelete } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login, runIndex } from "./helpers.js";

// Review Focus #3: search never leaks what the caller can't see.
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase().replace(/\d/g, "z");
const word = `authzword${tag}`;
const Hits = PageSchema(SearchHitSchema);
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let guest: U;
let member: U;
let admin: U;

async function mk(prefix: string, role: Member["role"] = "member"): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

/** Publishes, then fires the DO alarm that indexes it (C3). */
const pub = async (title: string, visibility: string) => {
  const r = await publish(
    env,
    owner.member,
    { title, visibility, format: "markdown", content: word } as never,
    null,
  );
  await runIndex(r.id);
  return r;
};

const ids = async (u: U) => {
  const r = await api(app, `${R.search}?q=${word}&limit=100`, u.cookie);
  expect(r.status).toBe(200);
  return Hits.parse(await r.json())
    .items.map((x) => x.id)
    .sort();
};

const e = (u: U) => normalizeEmail(u.email) ?? u.email;

beforeAll(async () => {
  owner = await mk("sa-owner");
  guest = await mk("sa-guest", "guest");
  member = await mk("sa-member");
  admin = await mk("sa-admin", "admin");
});

describe("search authz", () => {
  it("guest sees only what is shared with them, none after unshare; deleted never appear", async () => {
    const priv = await pub("private", "private");
    const team = await pub("team", "team");
    const pubA = await pub("public", "public");
    const shared = await pub("shared", "private");
    await getDb(env)
      .insert(shares)
      .values({
        artifactId: shared.id,
        email: e(guest),
        role: "viewer",
        createdBy: owner.userId,
        createdAt: Date.now(),
      });

    expect(await ids(guest)).toEqual([shared.id]);
    expect(await ids(member)).toEqual([team.id, pubA.id].sort());
    expect(await ids(owner)).toEqual(
      [priv.id, team.id, pubA.id, shared.id].sort(),
    );

    await getDb(env)
      .delete(shares)
      .where(and(eq(shares.artifactId, shared.id), eq(shares.email, e(guest))));
    expect(await ids(guest)).toEqual([]);

    await softDelete(env, owner.member, team.id);
    expect(await ids(member)).toEqual([pubA.id]);
    expect(await ids(owner)).not.toContain(team.id);
    // Deleted even with a stale FTS row: excluded by the join filter.
    await env.DB.prepare(
      "insert into artifact_search (rowid, artifact_id, title, description, body) select rowid, id, title, description, ? from artifacts where id = ?",
    )
      .bind(word, team.id)
      .run();
    expect(await ids(owner)).not.toContain(team.id);
    expect(await ids(member)).not.toContain(team.id);
    await env.DB.prepare(
      "delete from artifact_search where rowid = (select rowid from artifacts where id = ?)",
    )
      .bind(team.id)
      .run();

    await undelete(env, owner.member, team.id);
    await runIndex(team.id);
    expect(await ids(member)).toEqual([team.id, pubA.id].sort());
  });
});

describe("search with spaces (P3 T4)", () => {
  const w2 = `spaceword${tag}`;
  const pub2 = async (title: string, visibility: string) => {
    const r = await publish(
      env,
      owner.member,
      { title, visibility, format: "markdown", content: w2 } as never,
      null,
    );
    await runIndex(r.id);
    return r;
  };
  const hits = async (u: U, extra = "") => {
    const r = await api(app, `${R.search}?q=${w2}&limit=100${extra}`, u.cookie);
    expect(r.status).toBe(200);
    return Hits.parse(await r.json()).items;
  };

  it("search never returns another user's personal artifact to an admin", async () => {
    const priv = await pub2("personal", "private");
    expect((await hits(owner)).map((h) => h.id)).toEqual([priv.id]);
    expect(await hits(admin)).toEqual([]);
  });

  it("levels per hit come from the space role; spaceId narrows", async () => {
    const sid = newId();
    const db = getDb(env);
    await db.insert(spaces).values({
      id: sid,
      kind: "shared",
      name: `s-${tag}`,
      createdAt: Date.now(),
    });
    await db.insert(spaceMembers).values({
      spaceId: sid,
      userId: admin.userId,
      role: "manager",
      source: "manual",
      createdAt: Date.now(),
    });
    const inSpace = await pub2("in space", "private");
    await db
      .update(artifacts)
      .set({ spaceId: sid })
      .where(eq(artifacts.id, inSpace.id));
    const got = await hits(admin, `&spaceId=${sid}`);
    expect(got.map((h) => [h.id, h.access])).toEqual([[inSpace.id, "manager"]]);
    // The creator has no role in the space: it left their personal space.
    expect((await hits(owner)).map((h) => h.id)).not.toContain(inSpace.id);
    const personal = await api(
      app,
      `${R.search}?q=${w2}&spaceId=${owner.userId}`,
      admin.cookie,
    );
    expect(personal.status).toBe(400);
    expect((await errOf(personal)).code).toBe("space_personal");
  });
});
