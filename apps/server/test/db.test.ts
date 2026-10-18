import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

const DB = (env as unknown as { DB: D1Database }).DB;
const NOW = 1_700_000_000_000;

it("migrations are NNNN_name.sql, unique, contiguous from 0000, sorted", () => {
  // Workers runtime has no fs; list the dir through Vite instead.
  const files = Object.keys(
    (
      import.meta as unknown as {
        glob: (p: string, o: object) => Record<string, unknown>;
      }
    ).glob("../migrations/*.sql", { query: "?raw" }),
  ).map((f) => f.split("/").pop() ?? "");
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(f).toMatch(/^\d{4}_\w+\.sql$/);
  const prefixes = files.map((f) => Number(f.slice(0, 4)));
  expect(new Set(prefixes).size).toBe(prefixes.length);
  expect(prefixes).toEqual(prefixes.map((_, i) => i));
  expect(files).toEqual([...files].sort());
});

it("inserts a user and artifact; email unique is case-insensitive", async () => {
  await DB.prepare(
    "INSERT INTO users (id,email,name,role,created_at) VALUES ('u1','A@x.com','A','owner',?)",
  )
    .bind(NOW)
    .run();
  await DB.prepare(
    "INSERT INTO artifacts (id,owner_id,title,format,visibility,created_at,updated_at) VALUES ('a1','u1','T','html','private',?,?)",
  )
    .bind(NOW, NOW)
    .run();
  const a = await DB.prepare(
    "SELECT capabilities, current_version FROM artifacts WHERE id='a1'",
  ).first<{
    capabilities: string;
    current_version: number;
  }>();
  expect(JSON.parse(a!.capabilities)).toEqual({
    db: false,
    viewer: false,
    storage: false,
  });
  expect(a!.current_version).toBe(0);
  await expect(
    DB.prepare(
      "INSERT INTO users (id,email,name,role,created_at) VALUES ('u2','a@x.com','B','member',?)",
    )
      .bind(NOW)
      .run(),
  ).rejects.toThrow(/UNIQUE/);
});

it("check constraints reject bad values", async () => {
  const bad = (sql: string) =>
    expect(DB.prepare(sql).run()).rejects.toThrow(/CHECK/);
  await bad(
    "INSERT INTO users (id,email,name,role,created_at) VALUES ('u3','c@x.com','C','god',1)",
  );
  await bad(
    "INSERT INTO artifacts (id,owner_id,title,format,visibility,created_at,updated_at) VALUES ('a2','u1','T','exe','private',1,1)",
  );
  await bad(
    "INSERT INTO artifacts (id,owner_id,title,format,visibility,created_at,updated_at) VALUES ('a3','u1','T','html','secret',1,1)",
  );
  await bad(
    "INSERT INTO shares (artifact_id,email,role,created_by,created_at) VALUES ('a1','z@x.com','owner','u1',1)",
  );
});

it("seeds settings and supports FTS", async () => {
  const rows = await DB.prepare(
    "SELECT key,value FROM settings ORDER BY key",
  ).all();
  expect(rows.results).toEqual([
    { key: "default_visibility", value: "private" },
    { key: "name", value: "Open Artifacts" },
  ]);
  await DB.prepare(
    "INSERT INTO artifact_search (artifact_id,title,description,body) VALUES ('a1','T','d','hello world')",
  ).run();
  const r = await DB.prepare(
    "SELECT artifact_id FROM artifact_search WHERE artifact_search MATCH 'hello'",
  ).all();
  expect(r.results).toEqual([{ artifact_id: "a1" }]);
});

it("deleting an artifact cascades to versions and shares", async () => {
  await DB.prepare(
    "INSERT INTO artifacts (id,owner_id,title,format,visibility,created_at,updated_at) VALUES ('ac','u1','T','html','private',1,1)",
  ).run();
  await DB.prepare(
    "INSERT INTO versions (artifact_id,version,entry,created_by,created_at) VALUES ('ac',1,'index.html','u1',1)",
  ).run();
  await DB.prepare(
    "INSERT INTO shares (artifact_id,email,role,created_by,created_at) VALUES ('ac','s@x.com','viewer','u1',1)",
  ).run();
  await DB.prepare("DELETE FROM artifacts WHERE id='ac'").run();
  for (const t of ["versions", "shares"]) {
    const r = await DB.prepare(
      `SELECT count(*) AS n FROM ${t} WHERE artifact_id='ac'`,
    ).first<{ n: number }>();
    expect(r?.n).toBe(0);
  }
});

it("checks on flags and json columns", async () => {
  const bad = (sql: string) =>
    expect(DB.prepare(sql).run()).rejects.toThrow(/CHECK/);
  const base =
    "INSERT INTO artifacts (id,owner_id,title,format,visibility,created_at,updated_at,%C) VALUES ('ax','u1','T','html','private',1,1,%V)";
  await bad(base.replace("%C", "allow_anonymous_writes").replace("%V", "2"));
  await bad(base.replace("%C", "has_thumbnail").replace("%V", "-1"));
  await bad(base.replace("%C", "capabilities").replace("%V", "'{nope'"));
  await bad(
    "INSERT INTO versions (artifact_id,version,entry,manifest,created_by,created_at) VALUES ('a1',9,'e','not json','u1',1)",
  );
});

async function plan(sql: string): Promise<string> {
  const r = await DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{
    detail: string;
  }>();
  return r.results.map((x) => x.detail).join("\n");
}

it("list query uses a partial index", async () => {
  const p = await plan(
    "SELECT id FROM artifacts WHERE visibility IN ('team','public') AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20",
  );
  expect(p).toMatch(/artifacts_visibility_updated_live_idx/);
  // SQLite cannot avoid the ORDER BY sort across IN (...) values; partial index is what we assert.
});

it("FTS rows keyed by artifacts.rowid delete without a scan", async () => {
  const p = await plan(
    "DELETE FROM artifact_search WHERE rowid = (SELECT rowid FROM artifacts WHERE id = 'a1')",
  );
  // fts5 reports its rowid-equality lookup as "INDEX 0:="; full scans are "INDEX 0:" / "INDEX 1:..".
  expect(p).toMatch(/artifact_search VIRTUAL TABLE INDEX 0:=/);
  expect(p).not.toMatch(/SCAN artifacts/);
});
