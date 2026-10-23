// hosted-build (T3b): builds both bundle variants (@oa/provision buildBundle,
// one dry-run config, only the test-hooks define differs) and writes the
// hosted release artifact to <outdir>: release/ and redline/ modules, the
// assets, the server template, the D1 migrations, the Welcome text and
// manifest.json (path, size and sha256 of every file, bundleSha256 per
// variant). Every file is read with the hardened reader. No secrets.
// Needs `pnpm --filter @oa/provision build` and `pnpm --filter @oa/server build`.
// Usage: node --experimental-strip-types scripts/ci/build-hosted-release.ts <outdir>
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type File, type Mod, writeArtifact } from "./release-artifact.ts";

type Bundle = {
  modules: Mod[];
  mainModule: string;
  assetsDir: string;
  version: string;
};
type Read = (
  dir: string,
  o?: { pick?: (rel: string) => boolean },
) => Promise<File[]>;
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

const out = process.argv[2];
if (!out) {
  console.log("usage: build-hosted-release.ts <outdir>");
  process.exit(1);
}
const dist = pathToFileURL(join(root, "packages/provision/dist/index.js")).href;
const { buildBundle, readTreeHardened } = (await import(dist)) as {
  buildBundle(
    root: string,
    o: { variant: "release" | "redline" },
  ): Promise<Bundle>;
  readTreeHardened: Read;
};
const one = async (dir: string, name: string): Promise<Uint8Array> => {
  const [f] = await readTreeHardened(join(root, dir), {
    pick: (r) => r === name,
  });
  if (!f) throw new Error(`${dir}/${name} is missing`);
  return f.bytes;
};
const release = await buildBundle(root, { variant: "release" });
const redline = await buildBundle(root, { variant: "redline" });
if (
  release.mainModule !== redline.mainModule ||
  release.version !== redline.version
)
  throw new Error("the two variants disagree on the main module or version");
const r = await writeArtifact(resolve(out), {
  version: release.version,
  mainModule: release.mainModule,
  release: release.modules,
  redline: redline.modules,
  assets: await readTreeHardened(join(root, release.assetsDir)),
  template: await one("apps/server", "wrangler.template.jsonc"),
  migrations: (
    await readTreeHardened(join(root, "apps/server/migrations"), {
      pick: (p) => MIGRATION_RE.test(p),
    })
  ).map((f) => ({ name: f.path, bytes: f.bytes })),
  welcome: await one("scripts/setup", "welcome.md"),
});
console.log(
  `build-hosted-release: ${release.version}, manifest ${r.manifestSha256}, release ${r.bundleSha256.release}, redline ${r.bundleSha256.redline}`,
);
