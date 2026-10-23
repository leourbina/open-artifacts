// #248: artifacts has no non-partial owner/visibility index (each index entry
// is a billed D1 row write). Every query that could have used one still plans
// as an index SEARCH, never a full SCAN of the table.
import { env } from "cloudflare:workers";
import { type ListQuery, type Member, newId } from "@oa/shared";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { artifacts } from "../src/db/schema.js";
import { encodeCursor, listQuery } from "../src/services/artifacts.js";
import { searchQuery } from "../src/services/search.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

type Q = { sql: string; params?: unknown[] };
async function plan(q: Q): Promise<string> {
  const { results } = await env.DB.prepare(`explain query plan ${q.sql}`)
    .bind(...(q.params ?? []))
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

let member: Member;
const user = () => ({ kind: "user" as const, user: member });
const list = (q: Partial<ListQuery>) =>
  listQuery(env, user(), {
    scope: "all",
    limit: 25,
    includeDeleted: false,
    ...q,
  }).toSQL();
// The member-removal transfer (services/members.ts), live and deleted halves.
const transfer = (deleted: boolean) =>
  getDb(env)
    .update(artifacts)
    .set({ ownerId: "b" })
    .where(
      sql`${artifacts.ownerId} = ${"a"} and ${artifacts.deletedAt} is ${sql.raw(deleted ? "not null" : "null")}`,
    )
    .toSQL();

const OWNER = "artifacts_owner_updated_live_idx";
const SPACE = "artifacts_space_live_idx";
const VIS = "artifacts_visibility_updated_live_idx";
const TRASH = "artifacts_owner_deleted_idx";
const s = (...parts: string[]) => new RegExp(parts.join("[\\s\\S]*"));
/** The spaces branches: role rows, then allMembersRole and Every-space spaces. */
const SPACES = [
  "SEARCH sm USING COVERING INDEX space_members_user_idx",
  `SEARCH artifacts USING INDEX ${SPACE}`,
  `SEARCH artifacts USING INDEX ${SPACE}`,
];
/** MULTI-INDEX OR over mine, shared-with-me, team and spaces (P3 T4). */
const ALL = s(
  "MULTI-INDEX OR",
  `SEARCH artifacts USING INDEX ${OWNER}`,
  "SEARCH artifacts USING INDEX sqlite_autoindex_artifacts_1",
  `SEARCH artifacts USING INDEX ${VIS}`,
  ...SPACES,
);

/** name → query, and what its plan must contain. */
const queries: Record<string, { q: () => Q; plan: RegExp; not?: RegExp }> = {
  // Walks the ordered index and stops at the limit: no full sort (only the
  // id tiebreak, "FOR LAST TERM OF ORDER BY", as before spaces).
  "list mine": {
    q: () => list({ scope: "mine" }),
    plan: s(`SEARCH artifacts USING INDEX ${OWNER}`),
    not: /TEMP B-TREE FOR ORDER BY/,
  },
  "list spaces": {
    q: () => list({ scope: "spaces" }),
    plan: s("MULTI-INDEX OR", ...SPACES),
  },
  "list space": {
    q: () => list({ scope: "space", spaceId: "s" }),
    plan: s(`SEARCH artifacts USING INDEX ${SPACE}`),
  },
  "list team": {
    q: () => list({ scope: "team" }),
    plan: s(`SEARCH artifacts USING INDEX ${VIS}`),
  },
  "list shared": {
    q: () => list({ scope: "shared" }),
    plan: s("SEARCH artifacts USING INDEX sqlite_autoindex_artifacts_1"),
  },
  "list all": { q: () => list({ scope: "all" }), plan: ALL },
  "list all, cursor": {
    q: () => list({ scope: "all", cursor: encodeCursor({ u: 1, i: newId() }) }),
    plan: ALL,
  },
  "list all, visibility=public": {
    q: () => list({ scope: "all", visibility: "public" }),
    plan: s(`SEARCH artifacts USING INDEX ${VIS}`),
  },
  "list all, owner filter": {
    q: () => list({ scope: "all", owner: "x@x.com" }),
    plan: s(`SEARCH artifacts USING INDEX ${OWNER}`),
  },
  "list all, q": {
    q: () => list({ scope: "all", q: "hello" }),
    plan: s("SEARCH artifacts USING INTEGER PRIMARY KEY"),
  },
  "trash: list mine, includeDeleted": {
    q: () => list({ scope: "mine", includeDeleted: true }),
    plan: s(
      "MULTI-INDEX OR",
      `SEARCH artifacts USING INDEX ${OWNER}`,
      `SEARCH artifacts USING INDEX ${TRASH}`,
    ),
  },
  "trash: list team, includeDeleted": {
    q: () => list({ scope: "team", includeDeleted: true }),
    plan: s(
      `SEARCH artifacts USING INDEX ${VIS}`,
      `SEARCH artifacts USING INDEX ${TRASH}`,
    ),
  },
  "trash: list all, includeDeleted": {
    q: () => list({ scope: "all", includeDeleted: true }),
    plan: s(
      "MULTI-INDEX OR",
      `SEARCH artifacts USING INDEX ${OWNER}`,
      "sqlite_autoindex_artifacts_1",
      `SEARCH artifacts USING INDEX ${VIS}`,
      ...SPACES,
      `SEARCH artifacts USING INDEX ${TRASH}`,
    ),
  },
  search: {
    q: () => searchQuery(env, user(), '"hello"', 0, 25).toSQL(),
    plan: s("SEARCH artifacts USING INTEGER PRIMARY KEY"),
  },
  "purge cron": {
    q: () => ({
      sql: `select id, rowid as rid, purge_attempts as attempts from artifacts
     where deleted_at is not null and deleted_at < ?
       and (purge_after is null or purge_after <= ?)
     order by purge_attempts, deleted_at limit ?`,
      params: [1, 1, 50],
    }),
    plan: s("SEARCH artifacts USING INDEX artifacts_deleted_idx"),
  },
  "reindex cron": {
    q: () => ({
      sql: `select a.id, a.current_version as v from artifacts a
     join versions v on v.artifact_id = a.id and v.version = a.current_version
     where a.deleted_at is null and v.text_indexed = 0
       and coalesce(v.format, a.format) <> 'pdf' and a.updated_at < ?
     order by a.updated_at limit ?`,
      params: [1, 50],
    }),
    // Unchanged by #248: walks a live partial index (live rows only). 0009's
    // narrower artifacts_space_live_idx reads the same live rows and SQLite
    // now prefers it; either is a live-only scan, never the table.
    plan: s(`SCAN a USING INDEX (artifacts_space_live_idx|${OWNER})`),
  },
  "member removal: transfer live": {
    q: () => transfer(false),
    plan: s(`SEARCH artifacts USING INDEX ${OWNER}`),
  },
  "member removal: transfer deleted": {
    q: () => transfer(true),
    plan: s(`SEARCH artifacts USING COVERING INDEX ${TRASH}`),
  },
};

describe("artifacts query plans (#248)", () => {
  beforeAll(async () => {
    const { userId } = await login("plans@x.com");
    member = (await getUser(env, userId)) as Member;
  });

  for (const [name, { q, plan: want, not }] of Object.entries(queries)) {
    it(name, async () => {
      const p = await plan(q());
      // A bare "SCAN artifacts" (or its alias a) reads the whole table.
      expect(p).not.toMatch(/^SCAN (artifacts|a)$/m);
      expect(p).toMatch(want);
      if (not) expect(p).not.toMatch(not);
    });
  }
});
