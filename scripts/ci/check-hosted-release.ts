// hosted-check (T3b): verifies every hash of the hosted release artifact
// against its manifest.json (hardened read, exact file set) and prints, as
// GITHUB_OUTPUT lines, the release bundleSha256 recomputed from the bytes
// and the sha256 of manifest.json. hosted-sign requires both.
// Usage: node --experimental-strip-types scripts/ci/check-hosted-release.ts <artifact-dir>
import { resolve } from "node:path";
import {
  assertNoHookRoutes,
  bundleSha256,
  readArtifact,
} from "./release-artifact.ts";

const NAME = "check-hosted-release";

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir || process.argv.length > 3)
    throw new Error("usage: check-hosted-release.ts <artifact-dir>");
  const a = await readArtifact(resolve(dir));
  // The real build tree-shakes the hooks out of release: no route string left.
  assertNoHookRoutes(a.release);
  const b = bundleSha256({
    mainModule: a.manifest.mainModule,
    modules: a.release,
  });
  process.stdout.write(
    `bundle_sha256=${b}\nmanifest_sha256=${a.manifestSha256}\n`,
  );
  process.stderr.write(
    `${NAME}: ok: ${a.manifest.files.length} files match manifest.json\n`,
  );
}

await main().catch((e: unknown) => {
  const msg = (e instanceof Error ? e.message : String(e))
    .replace(/\s+/g, " ")
    .slice(0, 300);
  process.stderr.write(`${NAME}: FAIL: ${msg}\n`);
  process.exit(1);
});
