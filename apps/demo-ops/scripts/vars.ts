// Maps ops/demo/ids.json slugs to the demo-ops worker's id vars, for `wrangler deploy --var`.
//   node --experimental-strip-types apps/demo-ops/scripts/vars.ts [ids.json]
// Prints one `NAME:VALUE` per line (always all six). A missing slug, a missing file or an
// id that is not a valid artifact id (isId) gives an empty value, which the worker skips.
import { existsSync, readFileSync } from "node:fs";
import { isId } from "@oa/shared";

export const MAPPING = {
  poll: "POLL_ID",
  pixels: "CANVAS_ID",
  map: "MAP_ID",
  tictactoe: "TICTACTOE_ID",
  chess: "CHESS_ID",
  dashboard: "DASHBOARD_ARTIFACT_ID",
} as const;

export function deployVars(idsJson: string | undefined): string[] {
  let ids: Record<string, unknown> = {};
  if (idsJson !== undefined) {
    try {
      const j: unknown = JSON.parse(idsJson);
      if (typeof j === "object" && j !== null && !Array.isArray(j))
        ids = j as Record<string, unknown>;
      else console.error("ids.json: not an object; passing empty ids");
    } catch {
      console.error("ids.json: not JSON; passing empty ids");
    }
  }
  return Object.entries(MAPPING).map(([slug, name]) => {
    const id = ids[slug];
    if (typeof id === "string" && isId(id)) return `${name}:${id}`;
    if (id !== undefined)
      console.error(`ids.json: invalid id for ${slug}; passing empty`);
    return `${name}:`;
  });
}

if (process.argv[1]?.endsWith("vars.ts")) {
  const p = process.argv[2] ?? "ops/demo/ids.json";
  const lines = deployVars(existsSync(p) ? readFileSync(p, "utf8") : undefined);
  process.stdout.write(`${lines.join("\n")}\n`);
}
