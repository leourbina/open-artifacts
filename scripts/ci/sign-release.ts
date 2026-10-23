// hosted-sign (T3b): signs the hosted release artifact for one env. node:*
// imports only (and ./release-artifact.ts, likewise): this job installs
// nothing. The Ed25519 key (PKCS8 PEM) arrives on stdin only, never in argv,
// a file or a log:
//   printf '%s' "$RELEASE_SIGNING_KEY" | node --experimental-strip-types \
//     scripts/ci/sign-release.ts --dir <artifact> --env staging|prod \
//     --version <v> --manifest-sha256 <h> --bundle-sha256 <h> \
//     --commit <hosted-guard sha> --lockfile pnpm-lock.yaml --out <dir>
// Re-hashes every file against manifest.json, requires hosted-check's two
// hashes, both variants built from the guard's commit with the checked-out
// lockfile, no /__test/ route in release and the defines per variant, then
// signs each variant (staging: release and redline; prod: release) and writes
// oa-release-<env>-<variant>-<version>.tar and .sig.json. Prints only
// GITHUB_OUTPUT lines (<env>_<variant>_signature, _tar_sha256,
// _record_sha256) on stdout; errors go to stderr; exits 0 or 1.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Env,
  fileSha256,
  parseArgs,
  prepare,
  readArtifact,
  recordPayload,
  sigJson,
} from "./release-artifact.ts";

const NAME = "sign-release";
const ARGS = [
  "dir",
  "env",
  "version",
  "manifest-sha256",
  "bundle-sha256",
  "commit",
  "lockfile",
  "out",
];

async function readKey(): Promise<string> {
  if (process.stdin.isTTY)
    throw new Error("the signing key must come on stdin");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += (c as Buffer).length;
    if (n > 64 * 1024) throw new Error("stdin is too large for a signing key");
    chunks.push(c as Buffer);
  }
  const pem = Buffer.concat(chunks).toString("utf8");
  if (pem.trim() === "") throw new Error("no signing key on stdin");
  return pem;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2), ARGS);
  for (const k of ARGS) if (!a[k]) throw new Error(`--${k} is required`);
  const env = a.env as Env;
  if (env !== "staging" && env !== "prod")
    throw new Error("--env must be staging or prod");
  const pem = await readKey();
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    // Never echo the input.
    throw new Error("the key on stdin is not a PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("the signing key is not Ed25519");
  const pub = createPublicKey(key);
  const art = await readArtifact(resolve(a.dir as string));
  const prepared = prepare(art, {
    env,
    version: a.version as string,
    manifestSha256: a["manifest-sha256"] as string,
    bundleSha256: a["bundle-sha256"] as string,
    commit: a.commit as string,
    lockfileSha256: await fileSha256(resolve(a.lockfile as string)),
  });
  const signed = prepared.map((p) => {
    const payload = recordPayload(p.env, p.recordString);
    const signature = sign(null, payload, key).toString("base64url");
    if (!verify(null, payload, pub, Buffer.from(signature, "base64url")))
      throw new Error("the signature does not verify");
    return { p, signature };
  });
  // Nothing is written unless every variant signed.
  const out = resolve(a.out as string);
  await mkdir(out, { recursive: true });
  const lines: string[] = [];
  for (const { p, signature } of signed) {
    await writeFile(join(out, `${p.base}.tar`), p.tar, { flag: "wx" });
    await writeFile(join(out, `${p.base}.sig.json`), sigJson(p, signature), {
      flag: "wx",
    });
    const o = `${p.env}_${p.variant}`;
    lines.push(
      `${o}_signature=${signature}`,
      `${o}_tar_sha256=${p.tarSha256}`,
      `${o}_record_sha256=${p.recordSha256}`,
    );
    process.stderr.write(`${NAME}: signed ${p.base} (tar ${p.tarSha256})\n`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

await main().catch((e: unknown) => {
  const msg = (e instanceof Error ? e.message : String(e))
    .replace(/\s+/g, " ")
    .slice(0, 300);
  process.stderr.write(`${NAME}: FAIL: ${msg}\n`);
  process.exit(1);
});
