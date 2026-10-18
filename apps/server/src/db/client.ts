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
