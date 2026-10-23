import { env } from "cloudflare:workers";
import {
  type AccessLevel,
  type ListQueryInput,
  ListQuerySchema,
  type Member,
  newId,
  R,
  type Role,
  type SpaceRole,
  type Visibility,
} from "@oa/shared";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  authorize,
  type Caller,
  callerOf,
  capOfCaller,
} from "../src/auth/authz.js";
import { isTeamRole } from "../src/auth/policy.js";
import { publicPrefix } from "../src/content/signing.js";
import { getDb } from "../src/db/client.js";
import {
  artifacts,
  directoryGroups,
  directoryMembers,
  orgGroupMappings,
  shares,
  spaceMembers,
  spaces,
  users,
} from "../src/db/schema.js";
import { ApiError } from "../src/http/errors.js";
import { list, publish } from "../src/services/artifacts.js";
import { search } from "../src/services/search.js";
import { getUser } from "../src/services/users.js";
import { contentCall } from "./assets-stub.js";
import { api, errOf, login, runIndex } from "./helpers.js";

// P3 T4: list and search read the level from SQL (levelSql), and it must be
// decide()'s. The matrix seeds every input decide reads (space kind, per-space
// roles, allMembersRole, Every-space mappings, shares, visibility, publicLinks,
// deletion, the cap) and compares list(all), list(all, includeDeleted) and
// search with authorize() per artifact.

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

type Who =
  | "owner"
  | "admin"
  | "memberA"
  | "memberB"
  | "guest"
  | "restricted"
  | "everyEditor"
  | "everyViewerMgr"
  | "s1Viewer";
const ROLES: Record<Who, Role> = {
  owner: "owner",
  admin: "admin",
  memberA: "member",
  memberB: "member",
  guest: "guest",
  restricted: "member",
  everyEditor: "member",
  everyViewerMgr: "member",
  s1Viewer: "member",
};
const CALLERS = Object.keys(ROLES) as Who[];

type SpaceName = "pA" | "pOwner" | "s1" | "s2" | "s3" | "s4";
type Seed = {
  space: SpaceName;
  visibility: Visibility;
  deleted?: boolean;
};

const who = {} as Record<Who, { caller: Caller; cookie: string; id: string }>;
const spaceIds = {} as Record<SpaceName, string>;
const arts: Record<string, Seed & { id: string }> = {};
/** In every seeded artifact's search body. */
const word = `matrixword${tag}`.replace(/\d/g, "z");

const listAll = async (w: Who, q: ListQueryInput = {}) => {
  const out: Record<string, AccessLevel> = {};
  let cursor: string | undefined;
  do {
    const page = await list(
      env,
      who[w].caller,
      ListQuerySchema.parse({ limit: 100, ...q, cursor }),
    );
    for (const a of page.items) if (arts[a.id]) out[a.id] = a.access;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
};

const searchAll = async (w: Who) => {
  const out: Record<string, AccessLevel> = {};
  let cursor: string | undefined;
  do {
    const page = await search(env, who[w].caller, word, cursor, 100);
    for (const a of page.items) if (arts[a.id]) out[a.id] = a.access;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
};

const authorizeAll = async (w: Who, allowDeleted = false) => {
  const out: Record<string, AccessLevel | null> = {};
  for (const id of Object.keys(arts))
    out[id] = await authorize(env, who[w].caller, id, "view", {
      allowDeleted,
    }).then(
      (r) => r.level,
      (e) => {
        if (e instanceof ApiError && e.code === "not_found") return null;
        throw e;
      },
    );
  return out;
};

/** Uncapped owners, admins and members: the callers the team branch lists. */
const teamListed = (w: Who) => {
  const c = who[w].caller;
  return c.kind === "user" && isTeamRole(c.user.role) && !capOfCaller(c);
};

/**
 * Documented exception (as before spaces): a public artifact reachable only
 * by its link is not listed to guests or capped callers (they see what is
 * shared with them or in their spaces). Read from the rows: the caller's
 * share, or a role in the artifact's shared space (space_members or an
 * Every-space mapping).
 */
async function linkOnly(w: Who, id: string): Promise<boolean> {
  if (teamListed(w) || arts[id]?.visibility !== "public") return false;
  const r = await env.DB.prepare(
    `select exists (select 1 from shares where artifact_id = ?1 and email = ?2)
       or exists (select 1 from artifacts a join spaces s on s.id = a.space_id
         where a.id = ?1 and s.kind = 'shared' and (
           exists (select 1 from space_members sm
             where sm.space_id = a.space_id and sm.user_id = ?3)
           or exists (select 1 from org_group_mappings o
             join directory_members dm on dm.group_id = o.group_id
             where dm.user_id = ?3))) as path`,
  )
    .bind(id, `${w}-${tag}@x.com`, who[w].id)
    .first<{ path: number }>();
  return r?.path !== 1;
}

/** authorize()'s non-null levels, less the documented exceptions. */
async function expected(w: Who, allowDeleted = false) {
  const want: Record<string, AccessLevel> = {};
  for (const [id, level] of Object.entries(await authorizeAll(w, allowDeleted)))
    if (
      level &&
      !(await linkOnly(w, id)) &&
      // Follow-up: a shared space's trash waits for its own index.
      !(arts[id]?.deleted && level === "manager")
    )
      want[id] = level;
  return want;
}

beforeAll(async () => {
  const db = getDb(env);
  for (const w of CALLERS) {
    const { cookie, userId } = await login(`${w}-${tag}@x.com`, ROLES[w]);
    // A restricted group's member (sync keeps the flag; getUser reads it).
    if (w === "restricted")
      await db
        .update(users)
        .set({ restrictedSync: 1 })
        .where(eq(users.id, userId));
    const m = (await getUser(env, userId)) as Member;
    who[w] = { cookie, id: userId, caller: callerOf(m) };
  }
  spaceIds.pA = who.memberA.id;
  spaceIds.pOwner = who.owner.id;
  const now = Date.now();
  const shared = async (
    name: SpaceName,
    allMembersRole: SpaceRole | null,
    publicLinks: 0 | 1,
  ) => {
    spaceIds[name] = newId();
    await db.insert(spaces).values({
      id: spaceIds[name],
      kind: "shared",
      name: `${name}-${tag}`,
      allMembersRole,
      publicLinks,
      createdAt: now,
    });
  };
  await shared("s1", null, 1);
  await shared("s2", "editor", 0);
  await shared("s3", "viewer", 1);
  const role = async (
    space: SpaceName,
    w: Who,
    r: SpaceRole,
    source: "manual" | "sync" = "manual",
  ) => {
    await db.insert(spaceMembers).values({
      spaceId: spaceIds[space],
      userId: who[w].id,
      role: r,
      source,
      createdAt: now,
    });
  };
  await role("s1", "memberA", "editor");
  await role("s1", "memberB", "viewer", "sync");
  await role("s1", "memberB", "editor");
  await role("s1", "restricted", "editor");
  await role("s1", "guest", "viewer");
  await role("s1", "everyViewerMgr", "manager", "sync");
  await role("s2", "memberA", "manager");
  await role("s1", "s1Viewer", "viewer");
  // Every-space mappings: g1 editor (everyEditor, restricted), g2 viewer.
  const group = async (g: string, r: SpaceRole, members: Who[]) => {
    const groupId = `${g}-${tag}`;
    await db.insert(directoryGroups).values({ groupId, email: `${groupId}@x` });
    await db
      .insert(orgGroupMappings)
      .values({ groupId, groupEmail: `${groupId}@x`, role: r });
    for (const w of members)
      await db.insert(directoryMembers).values({ groupId, userId: who[w].id });
  };
  await group("g1", "editor", ["everyEditor", "restricted"]);
  await group("g2", "viewer", ["everyViewerMgr"]);
  // A shared space created after the mappings: they apply at read time.
  await shared("s4", null, 0);

  const mk = async (s: Seed) => {
    const id = newId();
    arts[id] = { ...s, id };
    await db.insert(artifacts).values({
      id,
      ownerId: s.space === "pOwner" ? who.owner.id : who.memberA.id,
      spaceId: spaceIds[s.space],
      title: `${s.space}-${s.visibility}`,
      format: "html",
      visibility: s.visibility,
      createdAt: now,
      updatedAt: now,
      deletedAt: s.deleted ? now : null,
    });
    await env.DB.prepare(
      "insert into artifact_search (rowid, artifact_id, title, description, body) select rowid, id, title, description, ? from artifacts where id = ?",
    )
      .bind(word, id)
      .run();
    return id;
  };
  const share = async (id: string, w: Who, r: "viewer" | "editor") => {
    await db.insert(shares).values({
      artifactId: id,
      email: `${w}-${tag}@x.com`,
      role: r,
      createdBy: who.memberA.id,
      createdAt: now,
    });
  };
  const byVis: Partial<Record<SpaceName, Record<Visibility, string>>> = {};
  for (const space of Object.keys(spaceIds) as SpaceName[]) {
    const row = {} as Record<Visibility, string>;
    for (const visibility of ["private", "team", "public"] as const)
      row[visibility] = await mk({ space, visibility });
    byVis[space] = row;
    await mk({ space, visibility: "team", deleted: true });
  }
  const at = (s: SpaceName, v: Visibility) => byVis[s]?.[v] as string;
  await share(at("pA", "private"), "memberB", "editor");
  await share(at("pA", "public"), "guest", "viewer");
  await share(at("pOwner", "private"), "admin", "viewer");
  await share(at("s2", "private"), "guest", "viewer");
  await share(at("s4", "private"), "restricted", "editor");
  await share(at("s1", "private"), "memberB", "viewer");
  await share(at("s3", "private"), "everyEditor", "viewer");
  // A space viewer whose editor share wins: max(spaceRole, shareRole).
  await share(at("s1", "private"), "s1Viewer", "editor");
});

describe("list levels come from SQL and equal authorize()", () => {
  it("list(all) ids and levels equal authorize() for every seeded artifact", async () => {
    for (const w of CALLERS) {
      const want = await expected(w);
      expect({ w, listed: await listAll(w) }).toEqual({ w, listed: want });
      expect({ w, searched: await searchAll(w) }).toEqual({
        w,
        searched: want,
      });
    }
  });

  it("list(all, includeDeleted) equals authorize(allowDeleted)", async () => {
    for (const w of CALLERS)
      expect({
        w,
        listed: await listAll(w, { includeDeleted: true }),
      }).toEqual({ w, listed: await expected(w, true) });
  });

  it("a space viewer with an editor share is editor", async () => {
    const id = Object.values(arts).find(
      (a) => a.space === "s1" && a.visibility === "private",
    )?.id as string;
    expect((await authorize(env, who.s1Viewer.caller, id, "view")).level).toBe(
      "editor",
    );
    expect((await listAll("s1Viewer"))[id]).toBe("editor");
    expect((await searchAll("s1Viewer"))[id]).toBe("editor");
  });

  it("a restricted Every-space editor is viewer in a space created after the mapping, and can't create there", async () => {
    const got = await listAll("restricted", {
      scope: "space",
      spaceId: spaceIds.s4,
    });
    expect(Object.keys(got)).toHaveLength(3);
    expect(new Set(Object.values(got))).toEqual(new Set(["viewer"]));
    const r = await api(app, R.artifacts, who.restricted.cookie, {
      method: "POST",
      body: {
        title: "t",
        format: "html",
        content: "<p>x",
        spaceId: spaceIds.s4,
      },
    });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("space_forbidden");
  });

  it("public artifacts in spaces with public links off are listed per decide (no exception)", async () => {
    // memberB has no role in s4 (public links off): the link alone lists it.
    const got = await listAll("memberB");
    for (const s of ["s2", "s4"] as const) {
      const id = Object.values(arts).find(
        (a) => a.space === s && a.visibility === "public" && !a.deleted,
      )?.id as string;
      expect(got[id]).toBe(s === "s2" ? "editor" : "viewer");
    }
  });

  it("the matrix covers every level and both kinds of space", async () => {
    const seen = new Set<string>();
    for (const w of CALLERS)
      for (const [id, l] of Object.entries(await listAll(w)))
        seen.add(`${l}:${arts[id]?.space.startsWith("p") ? "p" : "s"}`);
    expect([...seen].sort()).toEqual(
      [
        "owner:p",
        "editor:p",
        "viewer:p",
        "manager:s",
        "editor:s",
        "viewer:s",
      ].sort(),
    );
  });

  it("scope=space with another user's personal space id returns 400 space_personal and lists nothing", async () => {
    const r = await api(
      app,
      `${R.artifacts}?scope=space&spaceId=${who.owner.id}`,
      who.admin.cookie,
    );
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("space_personal");
    // spaceId narrows any scope, with the same refusal.
    const all = await api(
      app,
      `${R.artifacts}?scope=all&spaceId=${who.owner.id}`,
      who.admin.cookie,
    );
    expect(all.status).toBe(400);
  });

  it("scope=space needs spaceId; an unknown space is 404", async () => {
    const r = await api(app, `${R.artifacts}?scope=space`, who.admin.cookie);
    expect(r.status).toBe(400);
    const u = await api(
      app,
      `${R.artifacts}?scope=space&spaceId=${newId()}`,
      who.admin.cookie,
    );
    expect(u.status).toBe(404);
  });

  it("scope=space lists one shared space, at the same levels", async () => {
    const got = await listAll("memberA", {
      scope: "space",
      spaceId: spaceIds.s2,
    });
    const all = await listAll("memberA");
    const want = Object.fromEntries(
      Object.entries(all).filter(([id]) => arts[id]?.space === "s2"),
    );
    expect(got).toEqual(want);
    expect(Object.values(got)).toEqual(["manager", "manager", "manager"]);
    // The caller's own personal space is allowed (as scope=mine).
    const mine = await listAll("memberA", {
      scope: "space",
      spaceId: who.memberA.id,
    });
    expect(mine).toEqual(await listAll("memberA", { scope: "mine" }));
  });

  it("scope=spaces lists shared spaces only: roles, allMembersRole, Every space", async () => {
    const spacesOf = async (w: Who) =>
      [
        ...new Set(
          Object.keys(await listAll(w, { scope: "spaces" })).map(
            (id) => arts[id]?.space,
          ),
        ),
      ].sort();
    // memberA: s1 (editor), s2 (manager), s3 (allMembersRole viewer).
    expect(await spacesOf("memberA")).toEqual(["s1", "s2", "s3"]);
    // Org admins get nothing from their org role.
    expect(await spacesOf("admin")).toEqual(["s2", "s3"]);
    // Guests and capped callers never get allMembersRole.
    expect(await spacesOf("guest")).toEqual(["s1"]);
    expect(await spacesOf("restricted")).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("an Every-space editor mapping lists every shared space (including one created after the mapping) at editor, and no personal space", async () => {
    const got = await listAll("everyEditor", { scope: "spaces" });
    const bySpace: Record<string, Set<AccessLevel>> = {};
    for (const [id, l] of Object.entries(got)) {
      const s = arts[id]?.space as string;
      bySpace[s] = (bySpace[s] ?? new Set()).add(l);
    }
    // s2's allMembersRole is editor too; s3's viewer loses to the mapping.
    expect(Object.keys(bySpace).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    for (const levels of Object.values(bySpace))
      expect([...levels]).toEqual(["editor"]);
    expect(Object.keys(got)).toHaveLength(12);
    const all = await listAll("everyEditor");
    for (const id of Object.keys(all))
      if (arts[id]?.space.startsWith("p"))
        expect(arts[id]?.visibility).not.toBe("private");
  });

  it("Every-space viewer and per-space manager resolve to manager (max at read time)", async () => {
    const got = await listAll("everyViewerMgr", { scope: "spaces" });
    // s2's allMembersRole (editor) beats the Every-space viewer too.
    const want = { s1: "manager", s2: "editor", s3: "viewer", s4: "viewer" };
    for (const [id, l] of Object.entries(got))
      expect(l).toBe(want[arts[id]?.space as keyof typeof want]);
    expect(Object.keys(got)).toHaveLength(12);
  });

  it("a capped caller lists at viewer only, and never sees trash", async () => {
    const got = await listAll("restricted", { includeDeleted: true });
    expect(new Set(Object.values(got))).toEqual(new Set(["viewer"]));
    for (const id of Object.keys(got)) expect(arts[id]?.deleted).toBeFalsy();
  });

  it("trash lists the caller's own personal deleted artifacts as owner", async () => {
    const got = await listAll("memberA", {
      scope: "mine",
      includeDeleted: true,
    });
    const deleted = Object.keys(got).filter((id) => arts[id]?.deleted);
    expect(deleted).toHaveLength(1);
    expect(got[deleted[0] as string]).toBe("owner");
  });
});

describe("public links off only refuses new public links (decided)", () => {
  const word = `linkword${tag}`;
  let id: string;
  let sid: string;

  beforeAll(async () => {
    const db = getDb(env);
    const a = (await getUser(env, who.memberA.id)) as Member;
    id = (
      await publish(
        env,
        a,
        {
          title: "already public",
          format: "html",
          content: `<p>${word}</p>`,
          visibility: "public",
        } as never,
        null,
      )
    ).id;
    await runIndex(id);
    // A public artifact in a shared space with public links on, then the
    // toggle goes off (the spaces API is T9; the rows are what it writes).
    sid = newId();
    await db.insert(spaces).values({
      id: sid,
      kind: "shared",
      name: `links-${tag}`,
      publicLinks: 1,
      createdAt: Date.now(),
    });
    await db.insert(spaceMembers).values({
      spaceId: sid,
      userId: who.memberA.id,
      role: "manager",
      source: "manual",
      createdAt: Date.now(),
    });
    await db
      .update(artifacts)
      .set({ spaceId: sid })
      .where(eq(artifacts.id, id));
    await db.update(spaces).set({ publicLinks: 0 }).where(eq(spaces.id, sid));
  });

  it("an existing public artifact stays servable after the toggle goes off", async () => {
    expect((await contentCall(`${publicPrefix(id, 1)}__view`)).status).toBe(
      200,
    );
    const u = await api(app, R.contentUrl(id), null);
    expect(u.status).toBe(200);
    expect(((await u.json()) as { url: string }).url).toContain("/p/");
    expect((await api(app, R.artifact(id), null)).status).toBe(200);
    await expect(
      authorize(env, { kind: "anonymous" }, id, "view"),
    ).resolves.toMatchObject({ level: "viewer" });
  });

  it("lists and search match decide(): viewer by the link, manager by the role", async () => {
    for (const [w, level] of [
      ["memberB", "viewer"],
      ["memberA", "manager"],
    ] as const) {
      const page = await list(
        env,
        who[w].caller,
        ListQuerySchema.parse({ limit: 100 }),
      );
      expect(page.items.find((a) => a.id === id)?.access).toBe(level);
      const hits = await search(env, who[w].caller, word);
      expect(hits.items.map((h) => [h.id, h.access])).toEqual([[id, level]]);
      expect((await authorize(env, who[w].caller, id, "view")).level).toBe(
        level,
      );
    }
  });

  it("echoing visibility public on an already-public artifact is a no-op that passes", async () => {
    const keep = await api(app, R.artifact(id), who.memberA.cookie, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    expect(keep.status).toBe(200);
    const v = await api(app, R.versions(id), who.memberA.cookie, {
      method: "POST",
      body: { format: "html", content: "<p>echo", visibility: "public" },
    });
    expect(v.status).toBeLessThan(300);
    expect((await contentCall(`${publicPrefix(id, 1)}__view`)).status).toBe(
      200,
    );
  });

  it("a new public link is refused with public_links_off, even by a manager", async () => {
    const team = await api(app, R.artifact(id), who.memberA.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(team.status).toBe(200);
    for (const req of [
      // set_visibility (MCP) is this PATCH.
      { method: "PATCH", path: R.artifact(id), body: { visibility: "public" } },
      {
        method: "POST",
        path: R.versions(id),
        body: { format: "html", content: "<p>v2", visibility: "public" },
      },
    ]) {
      const r = await api(app, req.path, who.memberA.cookie, req);
      expect({ req: req.method, ...(await errOf(r)) }).toMatchObject({
        req: req.method,
        code: "public_links_off",
      });
      expect(r.status).toBe(403);
    }
    const row = await getDb(env)
      .select({ v: artifacts.visibility })
      .from(artifacts)
      .where(eq(artifacts.id, id));
    expect(row[0]?.v).toBe("team");
    expect((await contentCall(`${publicPrefix(id, 1)}__view`)).status).toBe(
      404,
    );
    // private → public is refused the same way.
    expect(
      (
        await api(app, R.artifact(id), who.memberA.cookie, {
          method: "PATCH",
          body: { visibility: "private" },
        })
      ).status,
    ).toBe(200);
    const fromPrivate = await api(app, R.artifact(id), who.memberA.cookie, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    expect(fromPrivate.status).toBe(403);
    expect((await errOf(fromPrivate)).code).toBe("public_links_off");
  });
});
