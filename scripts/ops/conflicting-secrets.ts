// Deploy step: print Worker secret names that are also vars in
// wrangler.staging.jsonc env.staging (a var+secret clash fails `wrangler
// deploy`). Reads `wrangler secret list --format json` on stdin; names only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripJsonc } from "./check-staging-secrets.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function conflictingSecrets(
  wranglerJsonc: string,
  listed: { name: string }[],
): string[] {
  const cfg = JSON.parse(stripJsonc(wranglerJsonc));
  const vars = new Set(Object.keys(cfg.env?.staging?.vars ?? {}));
  return listed.map((s) => s.name).filter((n) => vars.has(n));
}

function main(): number {
  const wrangler = readFileSync(
    join(root, "apps/server/wrangler.staging.jsonc"),
    "utf8",
  );
  let listed: { name: string }[];
  try {
    const raw = readFileSync(0, "utf8");
    const start = raw.indexOf("[");
    if (start < 0) throw new Error("no JSON array in input");
    listed = JSON.parse(raw.slice(start));
    if (!Array.isArray(listed)) throw new Error("not an array");
  } catch (e) {
    console.error(
      `::error::cannot parse wrangler secret list output: ${(e as Error).message}`,
    );
    return 2;
  }
  for (const n of conflictingSecrets(wrangler, listed)) console.log(n);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
