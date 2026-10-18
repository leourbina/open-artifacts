import { defineConfig } from "drizzle-kit";

// Migration rule: future migrations come from `drizzle-kit generate --name <name>`
// (keeps migrations/meta journal + snapshots committed and in sync). Then append any
// hand-edits the DSL cannot express (COLLATE NOCASE, FTS tables, seeds) to the new
// SQL file and list them in its header comment. Never rename generated files.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  migrations: { prefix: "index" },
});
