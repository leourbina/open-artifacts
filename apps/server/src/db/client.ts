import { eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.js";
import * as schema from "./schema.js";

export type Db = DrizzleD1Database<typeof schema>;

/**
 * One drizzle instance per D1 binding: drizzle() walks the whole schema
 * (extractTablesRelationalConfig) on every construction, which showed up in
 * every request's CPU profile. The instance holds no per-request state.
 */
const dbs = new WeakMap<D1Database, Db>();

export function getDb(env: Pick<Env, "DB">): Db {
  let db = dbs.get(env.DB);
  if (!db) {
    db = drizzle(env.DB, { schema });
    dbs.set(env.DB, db);
  }
  return db;
}

// Module-scope warm-up (startup limit, not a request's CPU): the first
// drizzle() and the first query build compile drizzle's code paths, ~1 ms of a
// cold isolate's first request. No binding is touched: the client is a
// placeholder and toSQL() only renders.
drizzle({} as D1Database, { schema })
  .select()
  .from(schema.tokens)
  .where(eq(schema.tokens.tokenHash, ""))
  .limit(1)
  .toSQL();
