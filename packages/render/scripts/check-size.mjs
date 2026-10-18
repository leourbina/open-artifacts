// Asserts the render entry (plus everything it imports statically) stays under
// 400 KB gzip, and that mermaid and pdf.js are lazy chunks. Reads dist/manifest.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const ENTRY_KEY = "src/index.ts";
export const MAX_GZIP = 400 * 1024;

export function checkBundle(dist) {
  const manifest = JSON.parse(
    readFileSync(join(dist, "manifest.json"), "utf8"),
  );
  const entry = manifest[ENTRY_KEY];
  if (!entry?.isEntry) throw new Error(`manifest has no entry ${ENTRY_KEY}`);
  const eager = new Set();
  const walk = (key) => {
    const c = manifest[key];
    if (!c || eager.has(c.file)) return;
    eager.add(c.file);
    for (const k of c.imports ?? []) walk(k);
  };
  walk(ENTRY_KEY);
  let gzip = 0;
  for (const f of eager) gzip += gzipSync(readFileSync(join(dist, f))).length;
  const lazy = Object.entries(manifest)
    .filter(([, c]) => !eager.has(c.file) && c.file.endsWith(".js"))
    .map(([k, c]) => ({ key: k, file: c.file }));
  const isLazy = (re) => lazy.some((c) => re.test(c.key));
  const eagerKeys = Object.entries(manifest)
    .filter(([, c]) => eager.has(c.file))
    .map(([k]) => k);
  const errors = [];
  if (!/^render\.[\w-]+\.js$/.test(entry.file))
    errors.push(`entry name ${entry.file}`);
  if (gzip >= MAX_GZIP) errors.push(`entry ${gzip} B gzip >= ${MAX_GZIP}`);
  if (!isLazy(/mermaid/)) errors.push("mermaid is not a lazy chunk");
  if (!isLazy(/pdfjs-dist/)) errors.push("pdf.js is not a lazy chunk");
  if (!Object.values(manifest).some((c) => /pdf\.worker/.test(c.file)))
    errors.push("pdf.js worker not emitted");
  for (const k of eagerKeys)
    if (/mermaid|pdfjs-dist|@shikijs\/langs/.test(k))
      errors.push(`eager: ${k}`);
  return {
    entry: entry.file,
    gzip,
    eager: [...eager],
    lazyCount: lazy.length,
    errors,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkBundle(join(import.meta.dirname, "..", "dist"));
  console.log(
    `render entry ${r.entry}: ${(r.gzip / 1024).toFixed(1)} KB gzip (eager: ${r.eager.join(", ")}); ${r.lazyCount} lazy chunks`,
  );
  if (r.errors.length) {
    console.error(r.errors.join("\n"));
    process.exit(1);
  }
}
