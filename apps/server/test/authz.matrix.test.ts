import { env } from "cloudflare:workers";
import {
  type AccessLevel,
  type ListQuery,
  type Member,
  newId,
  R,
  type Role,
  type Visibility,
} from "@oa/shared";
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  accessLevel,
  type Caller,
  listFilterSql,
  requireAccess,
} from "../src/auth/authz.js";
import { getDb } from "../src/db/client.js";
import { artifacts, shares } from "../src/db/schema.js";
import { ApiError } from "../src/http/errors.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://app.localhost${path}`, init), env, ctx);

type CallerName =
  | "creator"
  | "owner"
  | "admin"
  | "member"
  | "guestShared"
  | "guestNone"
  | "anonymous";
type ArtName =
  | "private"
  | "team"
  | "public"
  | "sharedViewer"
  | "sharedEditor"
  | "deleted";

const ROLES: Record<Exclude<CallerName, "anonymous">, Role> = {
  creator: "member",
  owner: "owner",
  admin: "admin",
  member: "member",
  guestShared: "guest",
  guestNone: "guest",
};

// Expected level for each [artifact][caller]; null = no access.
const O = "owner",
  E = "editor",
  V = "viewer",
  _ = null;
const MATRIX: Record<ArtName, Record<CallerName, AccessLevel | null>> = {
  //            creator owner admin member guestShared guestNone anonymous
  private: row(O, _, _, _, _, _, _),
  team: row(O, V, V, V, _, _, _),
  public: row(O, V, V, V, V, V, V),
  sharedViewer: row(O, _, _, _, V, _, _),
  sharedEditor: row(O, _, _, _, E, _, _),
  deleted: row(_, _, _, _, _, _, _),
};
function row(
  ...l: (AccessLevel | null)[]
): Record<CallerName, AccessLevel | null> {
  const [creator, owner, admin, member, guestShared, guestNone, anonymous] =
    l as (AccessLevel | null)[];
  return {
    creator: creator ?? null,
    owner: owner ?? null,
    admin: admin ?? null,
    member: member ?? null,
    guestShared: guestShared ?? null,
    guestNone: guestNone ?? null,
    anonymous: anonymous ?? null,
  };
}

const callers = {} as Record<CallerName, Caller>;
const cookies = {} as Record<Exclude<CallerName, "anonymous">, string>;
const ids = {} as Record<ArtName, string>;
const tag = newId().slice(0, 6).toLowerCase();

beforeAll(async () => {
  const db = getDb(env);
  for (const [name, role] of Object.entries(ROLES) as [
    Exclude<CallerName, "anonymous">,
    Role,
  ][]) {
    const { cookie, userId } = await login(`${name}-${tag}@x.com`, role);
    cookies[name] = cookie;
    callers[name] = {
      kind: "user",
      user: (await getUser(env, userId)) as Member,
    };
  }
  callers.anonymous = { kind: "anonymous" };
  const creatorId = (callers.creator as { user: Member }).user.id;
  const now = Date.now();
  const mk = async (
    name: ArtName,
    visibility: Visibility,
    deleted = false,
  ): Promise<void> => {
    ids[name] = newId();
    await db.insert(artifacts).values({
      id: ids[name],
      ownerId: creatorId,
      spaceId: creatorId,
      title: name,
      format: "html",
      visibility,
      createdAt: now,
      updatedAt: now,
      deletedAt: deleted ? now : null,
    });
  };
  await mk("private", "private");
  await mk("team", "team");
  await mk("public", "public");
  await mk("sharedViewer", "private");
  await mk("sharedEditor", "private");
  await mk("deleted", "team", true);
  // Share emails stored in mixed case: matching must ignore case.
  await db.insert(shares).values([
    {
      artifactId: ids.sharedViewer,
      email: `GuestShared-${tag}@X.com`,
      role: "viewer",
      createdBy: creatorId,
      createdAt: now,
    },
    {
      artifactId: ids.sharedEditor,
      email: `guestshared-${tag}@x.com`,
      role: "editor",
      createdBy: creatorId,
      createdAt: now,
    },
    // A share on the deleted artifact must not resurrect it.
    {
      artifactId: ids.deleted,
      email: `guestshared-${tag}@x.com`,
      role: "editor",
      createdBy: creatorId,
      createdAt: now,
    },
  ]);
});

describe("accessLevel matrix", () => {
  for (const art of Object.keys(MATRIX) as ArtName[]) {
    for (const who of Object.keys(MATRIX[art]) as CallerName[]) {
      const want = MATRIX[art][who];
      it(`${who} → ${art} = ${want}`, async () => {
        const got = await accessLevel(env, callers[who], ids[art]);
        expect(got?.level ?? null).toBe(want);
        if (got) expect(got.artifact.id).toBe(ids[art]);
      });
    }
  }

  it("unknown id → null", async () => {
    expect(await accessLevel(env, callers.owner, newId())).toBeNull();
  });

  it("deleted: only the creator, only with allowDeleted", async () => {
    expect(
      (
        await accessLevel(env, callers.creator, ids.deleted, {
          allowDeleted: true,
        })
      )?.level,
    ).toBe("owner");
    for (const who of ["owner", "admin", "member", "guestShared"] as const) {
      expect(
        await accessLevel(env, callers[who], ids.deleted, {
          allowDeleted: true,
        }),
      ).toBeNull();
    }
  });
});

describe("requireAccess", () => {
  const notFound = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("not_found");
  };
  it("returns the row when the level suffices", async () => {
    const a = await requireAccess(
      env,
      callers.guestShared,
      ids.sharedEditor,
      "editor",
    );
    expect(a.id).toBe(ids.sharedEditor);
    await requireAccess(env, callers.anonymous, ids.public, "viewer");
    await requireAccess(env, callers.creator, ids.private, "owner");
  });
  it("insufficient or no access → not_found (never forbidden)", async () => {
    await notFound(
      requireAccess(env, callers.guestShared, ids.sharedViewer, "editor"),
    );
    await notFound(
      requireAccess(env, callers.guestShared, ids.sharedEditor, "owner"),
    );
    await notFound(requireAccess(env, callers.member, ids.team, "editor"));
    await notFound(requireAccess(env, callers.admin, ids.private, "viewer"));
    await notFound(requireAccess(env, callers.anonymous, ids.team, "viewer"));
    await notFound(requireAccess(env, callers.creator, ids.deleted, "viewer"));
  });
});

describe("listFilterSql", () => {
  const listed = async (
    who: CallerName,
    scope: ListQuery["scope"],
    includeDeleted = false,
  ) =>
    new Set(
      (
        await getDb(env)
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(
            and(
              inArray(artifacts.id, Object.values(ids)),
              listFilterSql(callers[who], scope, includeDeleted),
            ),
          )
      ).map((r) => r.id),
    );
  const names = (s: Set<string>) =>
    (Object.keys(ids) as ArtName[]).filter((n) => s.has(ids[n])).sort();

  for (const who of Object.keys(MATRIX.private) as CallerName[]) {
    it(`scope all == {a : accessLevel(a) != null} for ${who}`, async () => {
      const want = new Set<string>();
      for (const art of Object.keys(ids) as ArtName[]) {
        if ((await accessLevel(env, callers[who], ids[art])) === null) continue;
        // Documented exceptions: public artifacts reachable only by link are
        // not listed to guests (spec: guests see only what's shared) or to
        // anonymous callers (list routes require a user).
        const viaLinkOnly =
          art === "public" && (who.startsWith("guest") || who === "anonymous");
        if (!viaLinkOnly) want.add(ids[art]);
      }
      expect(names(await listed(who, "all"))).toEqual(names(want));
    });
  }

  for (const scope of ["shared", "all"] as const) {
    it(`query plan (${scope}): uncorrelated IN on shares_email_idx`, async () => {
      const q = getDb(env)
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(listFilterSql(callers.member, scope))
        .toSQL();
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .bind(...q.params)
        .all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail);
      // The team branch's public-links probe is a correlated PK lookup per
      // public row (P3 T4); the share IN must stay uncorrelated.
      expect(details.join("\n")).not.toMatch(
        /CORRELATED LIST SUBQUERY|SCAN artifacts/,
      );
      expect(details.some((d) => d.includes("shares_email_idx"))).toBe(true);
    });
  }

  it("scopes", async () => {
    expect(names(await listed("creator", "mine"))).toEqual(
      ["private", "public", "sharedEditor", "sharedViewer", "team"].sort(),
    );
    expect(names(await listed("guestShared", "shared"))).toEqual([
      "sharedEditor",
      "sharedViewer",
    ]);
    expect(names(await listed("creator", "shared"))).toEqual([]);
    expect(names(await listed("member", "team"))).toEqual(["public", "team"]);
    expect(names(await listed("admin", "team"))).toEqual(["public", "team"]);
    expect(names(await listed("guestShared", "team"))).toEqual([]);
    expect(names(await listed("member", "mine"))).toEqual([]);
    expect(names(await listed("anonymous", "all"))).toEqual([]);
  });

  it("includeDeleted adds only the caller's own deleted artifacts", async () => {
    expect(names(await listed("creator", "all", true))).toContain("deleted");
    expect(names(await listed("creator", "mine", true))).toContain("deleted");
    for (const who of ["owner", "admin", "member", "guestShared"] as const)
      expect(names(await listed(who, "all", true))).not.toContain("deleted");
  });
});

describe("revocation", () => {
  it("after unsharing, the guest gets null", async () => {
    const id = newId();
    const creatorId = (callers.creator as { user: Member }).user.id;
    const db = getDb(env);
    await db.insert(artifacts).values({
      id,
      ownerId: creatorId,
      spaceId: creatorId,
      title: "t",
      format: "html",
      createdAt: 1,
      updatedAt: 1,
    });
    await db.insert(shares).values({
      artifactId: id,
      email: `guestnone-${tag}@x.com`,
      role: "viewer",
      createdBy: creatorId,
      createdAt: 1,
    });
    expect((await accessLevel(env, callers.guestNone, id))?.level).toBe(
      "viewer",
    );
    await db
      .delete(shares)
      .where(
        and(
          eq(shares.artifactId, id),
          eq(shares.email, `guestnone-${tag}@x.com`),
        ),
      );
    expect(await accessLevel(env, callers.guestNone, id)).toBeNull();
  });

  it("after a member is removed, their next request is anonymous", async () => {
    const adm = cookies.admin;
    const victim = await login(`victim-${tag}@x.com`, "member");
    const me = await call(R.me, { headers: { cookie: victim.cookie } });
    expect(me.status).toBe(200);
    const del = await call(R.member(victim.userId), {
      method: "DELETE",
      headers: { cookie: adm, "x-oa-request": "1" },
    });
    expect(del.status).toBe(204);
    const after = await call(R.me, { headers: { cookie: victim.cookie } });
    expect(after.status).toBe(401);
  });
});
