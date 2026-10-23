// hosted-attach (T3b): rebuilds the signed release files from the artifact
// and hosted-sign's outputs, for `gh release upload`. The sign job may only
// use checkout and download-artifact, so it hands over the signature and
// the sha256 of the tar and the record; this rebuilds both from the same
// verified bytes and refuses unless they hash the same. No key here.
// node:* imports only (and ./release-artifact.ts).
// Usage: node --experimental-strip-types scripts/ci/assemble-release.ts
//   --dir <artifact> --env <env> --version <v> --manifest-sha256 <h>
//   --bundle-sha256 <h> --out <dir> --release <sig>:<tar sha256>:<record sha256>
//   [--redline <sig>:<tar sha256>:<record sha256>]
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Env,
  parseArgs,
  prepare,
  readArtifact,
  sigJson,
} from "./release-artifact.ts";

const NAME = "assemble-release";
const REQUIRED = [
  "dir",
  "env",
  "version",
  "manifest-sha256",
  "bundle-sha256",
  "out",
];

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2), [
    ...REQUIRED,
    "release",
    "redline",
  ]);
  for (const k of REQUIRED) if (!a[k]) throw new Error(`--${k} is required`);
  const env = a.env as Env;
  const art = await readArtifact(resolve(a.dir as string));
  const prepared = prepare(art, {
    env,
    version: a.version as string,
    manifestSha256: a["manifest-sha256"] as string,
    bundleSha256: a["bundle-sha256"] as string,
  });
  const variants = new Set(prepared.map((p) => p.variant));
  for (const v of ["release", "redline"] as const)
    if (a[v] !== undefined && !variants.has(v))
      throw new Error(`--${v} is not signed for ${env}`);
  const files = prepared.map((p) => {
    const m = /^([A-Za-z0-9_-]{86}):([0-9a-f]{64}):([0-9a-f]{64})$/.exec(
      a[p.variant] ?? "",
    );
    if (!m)
      throw new Error(
        `--${p.variant} needs <signature>:<tar sha256>:<record sha256>`,
      );
    if (m[2] !== p.tarSha256)
      throw new Error(`the ${p.variant} tar is not the one hosted-sign signed`);
    if (m[3] !== p.recordSha256)
      throw new Error(
        `the ${p.variant} record is not the one hosted-sign signed`,
      );
    return { p, signature: m[1] as string };
  });
  const out = resolve(a.out as string);
  await mkdir(out, { recursive: true });
  for (const { p, signature } of files) {
    await writeFile(join(out, `${p.base}.tar`), p.tar, { flag: "wx" });
    await writeFile(join(out, `${p.base}.sig.json`), sigJson(p, signature), {
      flag: "wx",
    });
    console.log(`${NAME}: ${p.base}.tar and .sig.json`);
  }
}

await main().catch((e: unknown) => {
  const msg = (e instanceof Error ? e.message : String(e))
    .replace(/\s+/g, " ")
    .slice(0, 300);
  process.stderr.write(`${NAME}: FAIL: ${msg}\n`);
  process.exit(1);
});
