import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.js";
import * as schema from "./schema.js";

export type Db = DrizzleD1Database<typeof schema>;

export function getDb(env: Pick<Env, "DB">): Db {
  return drizzle(env.DB, { schema });
}
