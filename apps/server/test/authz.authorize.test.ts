import { env } from "cloudflare:workers";
import { type Member, newId, R, type Visibility } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authorize, type Caller } from "../src/auth/authz.js";
import { getDb } from "../src/db/client.js";
import { artifacts, shares } from "../src/db/schema.js";
import { ApiError } from "../src/http/errors.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// P3 T3: authorize(action) is the one check; owner-or-manager actions go
// through can(), never an ownerId comparison or a level rank.

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; caller: Caller };
let editor: { cookie: string; caller: Caller };
let other: Caller;
const ids: Record<string, string> = {};

async function who(name: string) {
  const { cookie, userId } = await login(`${name}-${tag}@x.com`, "member");
  return {
    cookie,
    caller: {
      kind: "user",
      user: (await getUser(env, userId)) as Member,
    } as Caller,
  };
}

beforeAll(async () => {
  owner = await who("owner");
  editor = await who("editor");
  other = (await who("other")).caller;
  const ownerId = (owner.caller as { user: Member }).user.id;
  const now = Date.now();
  const mk = async (
    name: string,
    visibility: Visibility,
    caps = '{"db":false,"viewer":false,"storage":false}',
  ) => {
    ids[name] = newId();
    await getDb(env).insert(artifacts).values({
      id: ids[name],
      ownerId,
      spaceId: ownerId,
      title: name,
      format: "html",
      visibility,
      capabilities: caps,
      createdAt: now,
      updatedAt: now,
    });
  };
  await mk("art", "private");
  await mk("nodb", "private");
  await getDb(env)
    .insert(shares)
    .values(
      ["art", "nodb"].map((n) => ({
        artifactId: ids[n] as string,
        email: `editor-${tag}@x.com`,
        role: "editor",
        createdBy: ownerId,
        createdAt: now,
      })),
    );
});

const notFound = (p: Promise<unknown>) =>
  expect(p).rejects.toSatisfy(
    (e) => e instanceof ApiError && e.code === "not_found",
  );

describe("authorize", () => {
  it("returns the level when can(level, action) allows it", async () => {
    await expect(
      authorize(env, owner.caller, ids.art as string, "share"),
    ).resolves.toMatchObject({ level: "owner" });
    await expect(
      authorize(env, editor.caller, ids.art as string, "publish"),
    ).resolves.toMatchObject({ level: "editor" });
  });
  it("404s when the level can't take the action", async () => {
    await notFound(authorize(env, editor.caller, ids.art as string, "share"));
    await notFound(authorize(env, editor.caller, ids.art as string, "delete"));
    // Personal owner: transfer is theirs (managers never; see policy.table).
    await expect(
      authorize(env, owner.caller, ids.art as string, "transfer"),
    ).resolves.toMatchObject({ level: "owner" });
  });
  it("404s with no access at all", async () => {
    await notFound(authorize(env, other, ids.art as string, "view"));
    await notFound(
      authorize(env, { kind: "anonymous" }, ids.art as string, "view"),
    );
  });
  it("anonymous data writes need allowAnonymousWrites", async () => {
    await notFound(
      authorize(env, { kind: "anonymous" }, ids.art as string, "data.write"),
    );
  });
});

describe("sharing changes go through can, not ownerId", () => {
  it("an editor can PATCH the title but not visibility (owner only)", async () => {
    const ok = await api(app, R.artifact(ids.art as string), editor.cookie, {
      method: "PATCH",
      body: { title: "renamed" },
    });
    expect(ok.status).toBe(200);
    const no = await api(app, R.artifact(ids.art as string), editor.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(no.status).toBe(400);
  });
  it("the owner can PATCH visibility", async () => {
    const r = await api(app, R.artifact(ids.art as string), owner.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(r.status).toBe(200);
  });
});

describe("MCP data store: can(level, data.*) and the db capability", () => {
  it("a capped caller's write is refused; reads still work", async () => {
    const { store } = await import("../src/mcp/tools/data.js");
    const ownerId = (owner.caller as { user: Member }).user.id;
    const dbId = newId();
    const now = Date.now();
    await getDb(env).insert(artifacts).values({
      id: dbId,
      ownerId,
      spaceId: ownerId,
      title: "db",
      format: "html",
      visibility: "private",
      capabilities: '{"db":true,"viewer":false,"storage":false}',
      createdAt: now,
      updatedAt: now,
    });
    const capped = {
      ...(owner.caller as Caller & { kind: "user" }),
      cap: "restricted" as const,
    };
    await notFound(store({ env, caller: capped }, dbId, "data.write"));
    await expect(
      store({ env, caller: capped }, dbId, "data.read"),
    ).resolves.toBeDefined();
    await expect(
      store({ env, caller: owner.caller }, dbId, "data.write"),
    ).resolves.toBeDefined();
  });
  it("B14 narrowed: only the uncapped owner may seed a non-db artifact", async () => {
    const { store } = await import("../src/mcp/tools/data.js");
    const nodb = ids.nodb as string;
    const denied = (p: Promise<unknown>) =>
      expect(p).rejects.toSatisfy(
        (e) => e instanceof ApiError && e.code === "capability_denied",
      );
    await expect(
      store({ env, caller: owner.caller }, nodb, "data.write"),
    ).resolves.toBeDefined();
    await denied(store({ env, caller: editor.caller }, nodb, "data.write"));
    await denied(store({ env, caller: editor.caller }, nodb, "data.read"));
    const cappedOwner = {
      ...(owner.caller as Caller & { kind: "user" }),
      cap: "restricted" as const,
    };
    await denied(store({ env, caller: cappedOwner }, nodb, "data.read"));
  });
});

describe("gatherer fails closed and caps", () => {
  it("a capped caller never gets trash, even with allowDeleted", async () => {
    const ownerId = (owner.caller as { user: Member }).user.id;
    const gone = newId();
    const now = Date.now();
    await getDb(env).insert(artifacts).values({
      id: gone,
      ownerId,
      spaceId: ownerId,
      title: "gone",
      format: "html",
      visibility: "private",
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    });
    const capped = {
      ...(owner.caller as Caller & { kind: "user" }),
      cap: "restricted" as const,
    };
    await notFound(
      authorize(env, capped, gone, "view", { allowDeleted: true }),
    );
    await expect(
      authorize(env, owner.caller, gone, "undelete", { allowDeleted: true }),
    ).resolves.toMatchObject({ level: "owner" });
  });
});

describe("the cap travels with the member (M1)", () => {
  it("callerOf reads withCap; copies keep it; JSON never shows it", async () => {
    const { callerOf, withCap } = await import("../src/auth/authz.js");
    const m = withCap(
      { ...(owner.caller as { user: Member }).user },
      "restricted",
    );
    expect(callerOf(m)).toMatchObject({ kind: "user", cap: "restricted" });
    expect(callerOf({ ...m })).toMatchObject({ cap: "restricted" });
    expect(JSON.stringify(m)).not.toContain("restricted");
    expect(callerOf(null)).toEqual({ kind: "anonymous" });
  });
  it("services that take a Member honour its cap (no rebuilt uncapped Caller)", async () => {
    const { withCap } = await import("../src/auth/authz.js");
    const { patch } = await import("../src/services/artifacts.js");
    const capped = withCap(
      { ...(owner.caller as { user: Member }).user },
      "restricted",
    );
    await notFound(patch(env, capped, ids.art as string, { title: "nope" }));
  });
});

describe("callerOf fails closed", () => {
  it("a member without a cap (toMember) throws", async () => {
    const { callerOf } = await import("../src/auth/authz.js");
    const { toMember } = await import("../src/services/users.js");
    const row = {
      id: "u1",
      email: "u1@x.com",
      name: null,
      displayName: null,
      role: "member",
      lastSeenAt: null,
    };
    expect(() => callerOf(toMember(row as never))).toThrow(
      "member without cap",
    );
  });
});

describe("rowLevel", () => {
  it("an unknown stored visibility is treated as private", async () => {
    const { rowLevel } = await import("../src/auth/authz.js");
    const ownerId = (owner.caller as { user: Member }).user.id;
    const now = Date.now();
    const row = {
      id: "x",
      ownerId,
      spaceId: ownerId,
      title: "odd",
      description: null,
      format: "html",
      visibility: "everyone",
      currentVersion: 1,
      capabilities: "{}",
      allowAnonymousWrites: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    } as unknown as Parameters<typeof rowLevel>[1];
    const personal = {
      kind: "personal",
      publicLinks: 1,
      allMembersRole: null,
      role: null,
    };
    expect(rowLevel(other, row, null, personal)).toBeNull();
    expect(rowLevel({ kind: "anonymous" }, row, null, personal)).toBeNull();
    expect(rowLevel(owner.caller, row, null, personal)).toBe("owner");
  });
});
