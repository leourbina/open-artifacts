import { env } from "cloudflare:workers";
import { normalizeEmail } from "@oa/auth-core";
import { type Member, newId, PageSchema, R, SearchHitSchema } from "@oa/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getDb } from "../src/db/client.js";
import { shares } from "../src/db/schema.js";
import { publish, softDelete, undelete } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login, runIndex } from "./helpers.js";

// Review Focus #3: search never leaks what the caller can't see.
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase().replace(/\d/g, "z");
const word = `authzword${tag}`;
const Hits = PageSchema(SearchHitSchema);
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let guest: U;
let member: U;

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
