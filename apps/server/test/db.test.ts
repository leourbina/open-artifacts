import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

const DB = (env as unknown as { DB: D1Database }).DB;
const NOW = 1_700_000_000_000;

it("migrations dir has exactly one NNNN_name.sql", () => {
  // Workers runtime has no fs; list the dir through Vite instead.
  const files = Object.keys(
    (
      import.meta as unknown as {
        glob: (p: string, o: object) => Record<string, unknown>;
      }
    ).glob("../migrations/*", { query: "?raw" }),
  ).map((f) => f.split("/").pop() ?? "");
  const sql = files.filter((f) => f.endsWith(".sql"));
  expect(sql).toHaveLength(1);
  expect(sql[0]).toMatch(/^\d{4}_\w+\.sql$/);
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
