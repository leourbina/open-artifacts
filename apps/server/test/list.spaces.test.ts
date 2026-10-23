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
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  authorize,
  type Caller,
  callerOf,
  withCap,
} from "../src/auth/authz.js";
import { getDb } from "../src/db/client.js";
import {
  artifacts,
  directoryGroups,
  directoryMembers,
  orgGroupMappings,
  shares,
  spaceMembers,
  spaces,
} from "../src/db/schema.js";
import { ApiError } from "../src/http/errors.js";
import { list } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

// P3 T4: list and search read the level from SQL (levelSql), and it must be
// decide()'s. The matrix seeds every input decide reads (space kind, per-space
// roles, allMembersRole, Every-space mappings, shares, visibility, publicLinks,
// deletion, the cap) and compares list(all) with authorize() per artifact.

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
  | "everyViewerMgr";
const ROLES: Record<Who, Role> = {
  owner: "owner",
  admin: "admin",
  memberA: "member",
  memberB: "member",
  guest: "guest",
  restricted: "member",
  everyEditor: "member",
  everyViewerMgr: "member",
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
/** Seeded paths that list without a space role or share: see `linkOnly`. */
const paths = new Set<string>();

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

const authorizeAll = async (w: Who) => {
  const out: Record<string, AccessLevel | null> = {};
  for (const id of Object.keys(arts))
    out[id] = await authorize(env, who[w].caller, id, "view").then(
      (r) => r.level,
      (e) => {
        if (e instanceof ApiError && e.code === "not_found") return null;
        throw e;
      },
    );
  return out;
};

const capped = (w: Who) => w === "guest" || w === "restricted";

/**
 * Documented exception (as before spaces): a public artifact reachable only
 * by its link is not listed to guests or capped callers (they see what is
 * shared with them or in their spaces).
 */
const linkOnly = (w: Who, id: string) =>
  capped(w) && arts[id]?.visibility === "public" && !paths.has(`${w}|${id}`);

beforeAll(async () => {
  const db = getDb(env);
  for (const w of CALLERS) {
    const { cookie, userId } = await login(`${w}-${tag}@x.com`, ROLES[w]);
    const m = (await getUser(env, userId)) as Member;
    who[w] = {
      cookie,
      id: userId,
      // Restriction columns are read by T6; the cap is what decide sees.
      caller: callerOf(w === "restricted" ? withCap(m, "restricted") : m),
    };
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
    paths.add(`${w}|${id}`);
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
  // Space roles that list a capped caller's public artifacts.
  for (const [w, s] of [
    ["guest", "s1"],
    ["restricted", "s1"],
    ["restricted", "s2"],
    ["restricted", "s3"],
    ["restricted", "s4"],
  ] as const)
    paths.add(`${w}|${at(s, "public")}`);
});

describe("list levels come from SQL and equal authorize()", () => {
  it("list(all) ids and levels equal authorize() for every seeded artifact", async () => {
    for (const w of CALLERS) {
      const listed = await listAll(w);
      const allowed = await authorizeAll(w);
      const want: Record<string, AccessLevel> = {};
      for (const [id, level] of Object.entries(allowed))
        if (level && !linkOnly(w, id)) want[id] = level;
      expect({ w, listed }).toEqual({ w, listed: want });
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
