// Deploy preflight: fail if a Worker secret the code requires is not set.
// Required = non-optional `string` fields of `Env` (apps/server/src/env.ts)
// that are not vars in wrangler.staging.jsonc. Reads the JSON from
// `wrangler secret list --format json` on stdin; prints names only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Strip // and /* *\/ comments outside of string literals. */
function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function requiredSecrets(
  envTs: string,
  wranglerJsonc: string,
): string[] {
  const body = /interface\s+Env\s*{([\s\S]*?)\n}/.exec(envTs)?.[1];
  if (body === undefined) throw new Error("interface Env not found");
  const cfg = JSON.parse(stripJsonc(wranglerJsonc));
  const vars = new Set(Object.keys(cfg.env?.staging?.vars ?? {}));
  const names: string[] = [];
  for (const m of body.matchAll(
    /^\s*([A-Za-z_][A-Za-z0-9_]*)(\?)?:\s*string\s*;/gm,
  )) {
    const name = m[1] as string;
    if (!m[2] && !vars.has(name)) names.push(name);
  }
  return names;
}

export function missingSecrets(
  envTs: string,
  wranglerJsonc: string,
  listed: { name: string }[],
): string[] {
  const have = new Set(listed.map((s) => s.name));
  return requiredSecrets(envTs, wranglerJsonc).filter((n) => !have.has(n));
}

function main(): number {
  const envTs = readFileSync(join(root, "apps/server/src/env.ts"), "utf8");
  const wrangler = readFileSync(
    join(root, "apps/server/wrangler.staging.jsonc"),
    "utf8",
  );
  let listed: { name: string }[];
  try {
    listed = JSON.parse(readFileSync(0, "utf8"));
    if (!Array.isArray(listed)) throw new Error("not an array");
  } catch (e) {
    console.error(
      `::error::cannot parse wrangler secret list output: ${(e as Error).message}`,
    );
    return 2;
  }
  const missing = missingSecrets(envTs, wrangler, listed);
  if (missing.length > 0) {
    console.error(`::error::missing Worker secrets: ${missing.join(", ")}`);
    return 1;
  }
  console.log(
    `ok: all ${requiredSecrets(envTs, wrangler).length} required Worker secrets are set`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
