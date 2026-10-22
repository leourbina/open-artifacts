// Writes the release Worker bundle to <outdir> via @oa/provision buildBundle
// (a `wrangler deploy --dry-run` of the rendered setup template with dummy
// values: no account, no secrets). Input for check-no-test-hooks.ts.
// Needs `pnpm --filter @oa/provision build`, `pnpm --filter @oa/server run gen`
// and an apps/server/dist-assets directory first.
// Usage: node --experimental-strip-types scripts/ci/build-release-bundle.ts <outdir>
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Bundle = {
  modules: { name: string; bytes: Uint8Array }[];
  mainModule: string;
};
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const out = process.argv[2];
if (!out) {
  console.log("usage: build-release-bundle.ts <outdir>");
  process.exit(1);
}
// The built package (dist), so its .js imports resolve under plain node.
const dist = pathToFileURL(join(root, "packages/provision/dist/index.js")).href;
const { buildBundle } = (await import(dist)) as {
  buildBundle(root: string): Promise<Bundle>;
};
const b = await buildBundle(root);
const dir = resolve(out);
for (const m of b.modules) {
  const p = join(dir, m.name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, m.bytes);
}
console.log(
  `build-release-bundle: ${b.modules.length} modules, main ${b.mainModule}, in ${dir}`,
);
