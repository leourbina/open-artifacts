// Asserts dist/runtime.<hash>.js is ≤ 8 KB gzip, the manifest names it, and the
// snapshot (html-to-image) and schemas (zod) chunks are lazy dynamic imports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const MAX_GZIP = 8 * 1024;

export function checkRuntime(dist) {
  const m = JSON.parse(
    readFileSync(join(dist, "runtime.manifest.json"), "utf8"),
  );
  const entry = m["src/index.ts"];
  const errors = [];
  if (!entry || !/^runtime\.[\w-]+\.js$/.test(entry.file ?? ""))
    return { gzip: 0, errors: ["manifest has no runtime entry"] };
  const code = readFileSync(join(dist, entry.file));
  const gzip = gzipSync(code, { level: 9 }).length;
  if (gzip > MAX_GZIP) errors.push(`runtime ${gzip} B gzip > ${MAX_GZIP}`);
  if (entry.imports?.length) errors.push("runtime must have no static imports");
  for (const name of ["snapshot", "schemas"]) {
    const f = m[`src/${name}.ts`]?.file ?? "";
    if (!new RegExp(`^${name}\\.[\\w-]+\\.js$`).test(f))
      errors.push(`no ${name} chunk`);
    else readFileSync(join(dist, f));
    if (!entry.dynamicImports?.includes(`src/${name}.ts`))
      errors.push(`${name} is not a dynamic import of the entry`);
    if (!f || !code.includes(f)) errors.push(`runtime does not load ${name}`);
  }
  // html-to-image and zod belong to the lazy chunks only.
  if (/toCanvas|ZodType|zod\.dev/.test(code.toString()))
    errors.push("html-to-image or zod is in the runtime entry");
  return { entry: entry.file, gzip, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkRuntime(join(import.meta.dirname, "..", "dist"));
  console.log(`runtime ${r.entry}: ${r.gzip} B gzip (max ${MAX_GZIP})`);
  if (r.errors.length) {
    console.error(r.errors.join("\n"));
    process.exit(1);
  }
}
