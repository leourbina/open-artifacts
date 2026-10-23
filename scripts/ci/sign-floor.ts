// hosted-floor (T3b H1): signs the env's release floor (releases/floor.json)
// with the env's release key, the only place that key exists. node:* imports
// only (and ./release-artifact.ts, ./release-pubkeys.ts): the job installs
// nothing. The key arrives on stdin only:
//   printf '%s' "$RELEASE_SIGNING_KEY" | node --experimental-strip-types \
//     scripts/ci/sign-floor.ts --env staging|prod --seq <n> \
//     --min-version <semver> --revoked "<semver>,<semver>" --out <dir>
// Writes <out>/floor-<env>-<seq>.sig.json and prints only GITHUB_OUTPUT
// lines (floor_signature, floor_record_sha256).
// With --assemble --signature <sig> --record-sha256 <h> (no key, the upload
// job): rebuilds the record from the same inputs, requires its sha256 and
// the signature (against the pinned key, once it is real), and writes the
// identical file. publishFloor takes the file; it is never a release asset.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, parseArgs, sha256Hex } from "./release-artifact.ts";
import {
  checkSigningKey,
  type Env,
  SKIPPED,
  verifySignature,
} from "./release-pubkeys.ts";

const NAME = "sign-floor";
const ARGS = ["env", "seq", "min-version", "revoked", "out"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The floor record from validated inputs, as its canonical string. */
function floorRecord(a: Record<string, string>): {
  env: Env;
  seq: number;
  record: string;
} {
  const env = a.env as Env;
  if (env !== "staging" && env !== "prod")
    throw new Error("--env must be staging or prod");
  const seqText = a.seq ?? "";
  if (!/^[1-9]\d{0,14}$/.test(seqText))
    throw new Error("--seq must be a positive integer");
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) throw new Error("--seq is too large");
  const minVersion = a["min-version"] ?? "";
  if (!SEMVER.test(minVersion))
    throw new Error("--min-version must be a release version");
  const rv = a.revoked ?? "";
  const revoked = rv === "" ? [] : rv.split(",");
  for (const v of revoked)
    if (!SEMVER.test(v))
      throw new Error(
        `--revoked has a non-version entry ${JSON.stringify(v).slice(0, 40)}`,
      );
  if (new Set(revoked).size !== revoked.length)
    throw new Error("--revoked repeats a version");
  return { env, seq, record: canonicalJson({ env, seq, minVersion, revoked }) };
}

const payloadOf = (env: Env, record: string) =>
  Buffer.from(`oa-release-floor-v1\n${env}\n${record}`);

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
  const argv = process.argv.slice(2);
  const assemble = argv.includes("--assemble");
  const a = parseArgs(
    argv.filter((x) => x !== "--assemble"),
    assemble ? [...ARGS, "signature", "record-sha256"] : ARGS,
  );
  for (const k of ARGS)
    if (a[k] === undefined) throw new Error(`--${k} is required`);
  const f = floorRecord(a);
  const payload = payloadOf(f.env, f.record);
  let signature: string;
  if (assemble) {
    if (a["record-sha256"] !== sha256Hex(f.record))
      throw new Error("the floor record is not the one hosted-floor signed");
    signature = a.signature ?? "";
    if (verifySignature(f.env, payload, signature) === "skipped")
      process.stderr.write(SKIPPED(f.env, "floor signature"));
  } else {
    const pem = await readKey();
    let key: ReturnType<typeof createPrivateKey>;
    try {
      key = createPrivateKey({ key: pem, format: "pem" });
    } catch {
      throw new Error("the key on stdin is not a PEM private key");
    }
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("the signing key is not Ed25519");
    const pub = createPublicKey(key);
    if (
      checkSigningKey(f.env, pub.export({ format: "jwk" }).x as string) ===
      "skipped"
    )
      process.stderr.write(SKIPPED(f.env, "signing key"));
    signature = sign(null, payload, key).toString("base64url");
    if (!verify(null, payload, pub, Buffer.from(signature, "base64url")))
      throw new Error("the signature does not verify");
  }
  const out = resolve(a.out as string);
  await mkdir(out, { recursive: true });
  const name = `floor-${f.env}-${f.seq}.sig.json`;
  await writeFile(
    join(out, name),
    JSON.stringify({ record: f.record, signature }),
    { flag: "wx" },
  );
  process.stderr.write(`${NAME}: wrote ${name}\n`);
  if (!assemble)
    process.stdout.write(
      `floor_signature=${signature}\nfloor_record_sha256=${sha256Hex(f.record)}\n`,
    );
}

await main().catch((e: unknown) => {
  const msg = (e instanceof Error ? e.message : String(e))
    .replace(/\s+/g, " ")
    .slice(0, 300);
  process.stderr.write(`${NAME}: FAIL: ${msg}\n`);
  process.exit(1);
});
