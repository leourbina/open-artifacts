// The signed release record (H-T4b): what a release uploads or applies, and
// how create proves it came from the release workflow. The provisioning token
// can write oa-<p>-releases, so the record is trusted only through its
// Ed25519 signature, made by the release workflow's key (T3b) and checked
// against RELEASE_PUBKEY[env], a constant in this file.
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Module } from "./cf.js";
import type { Env } from "./names.js";
import { canonicalJson } from "./platform.js";

/**
 * Compile-time define, confirmed by Backend: a BOOLEAN literal, `true` only in
 * the redline bundle and `false` in the release bundle.
 */
export const TEST_HOOKS_DEFINE = "__OA_TEST_HOOKS_ALLOWED__" as const;

export type BundleVariant = "release" | "redline";

/** Not a key. create refuses while RELEASE_PUBKEY[env] holds this. */
export const RELEASE_PUBKEY_PLACEHOLDER =
  "PLACEHOLDER-not-a-key-T3b-sets-the-release-signing-public-key";

/**
 * The release workflow's Ed25519 public key per env: base64url of the raw
 * 32 bytes (JWK `x`). TODO(T3b): set the real keys; the private keys live
 * only in the release workflow's secrets.
 */
export const RELEASE_PUBKEY: Readonly<Record<Env, string>> = Object.freeze({
  staging: RELEASE_PUBKEY_PLACEHOLDER,
  prod: RELEASE_PUBKEY_PLACEHOLDER,
});

export interface ReleaseAssetEntry {
  /** Relative, "/"-separated, no dot segment. */
  path: string;
  size: number;
  /** Full SHA-256 hex of the bytes. */
  sha256: string;
}

/**
 * The per-release manifest entry for one bundle variant, written and signed
 * by the release workflow after building both variants and running
 * check-no-test-hooks (T3b).
 * TODO(T3b): the two-variant buildBundle, the check-no-test-hooks gate, the
 * R2 ReleaseReader and the signed record writer are task T3b, a blocker
 * before any prod create (create throws ProdLocked until then).
 */
export interface ReleaseRecord {
  version: string;
  variant: BundleVariant;
  /** bundleSha256() of the modules. */
  sha256: string;
  /**
   * A JSON boolean, on purpose. Wrangler's `define` config holds the string
   * "true"/"false" (a JS expression the bundler substitutes, so the code sees
   * a real boolean and dead-code elimination works). This record is our own
   * schema: T3b converts the config string to a boolean when it writes it.
   * Do not change this to a string; create refuses one.
   */
  defines: { [TEST_HOOKS_DEFINE]: boolean };
  /** Every asset uploaded, sorted by path. */
  assets: ReleaseAssetEntry[];
  /** SHA-256 of the exact bytes of the server template file. */
  templateSha256: string;
  /** migrationsSha256() of every D1 migration file applied. */
  migrationsSha256: string;
}

/** The record plus a base64url Ed25519 signature over canonicalJson(record). */
export interface SignedReleaseRecord {
  record: ReleaseRecord;
  signature: string;
}

export interface ReleaseAsset {
  path: string;
  bytes: Uint8Array;
}

export interface ReleaseFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Reads one release's files (R2 oa-<p>-releases in production, T3b). Never
 * the local checkout. create calls each read again right before it uses the
 * result and checks it against the signed record every time.
 */
export interface ReleaseReader {
  record(
    version: string,
    variant: BundleVariant,
  ): Promise<SignedReleaseRecord | null>;
  modules(
    version: string,
    variant: BundleVariant,
  ): Promise<{ mainModule: string; modules: Module[] }>;
  assets(version: string, variant: BundleVariant): Promise<ReleaseAsset[]>;
  /** The exact bytes of the server template (wrangler.template.jsonc). */
  template(version: string, variant: BundleVariant): Promise<Uint8Array>;
  /** Every D1 migration file of the server. */
  migrations(version: string, variant: BundleVariant): Promise<ReleaseFile[]>;
}

export const sha256Hex = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

/** SHA-256 over the main module and every module's name, type and bytes. */
export function bundleSha256(b: {
  mainModule: string;
  modules: readonly Module[];
}): string {
  return sha256Hex(
    canonicalJson({
      mainModule: b.mainModule,
      modules: [...b.modules]
        .sort((x, y) => (x.name < y.name ? -1 : 1))
        .map((m) => ({
          name: m.name,
          type: m.type,
          sha256: sha256Hex(m.bytes),
        })),
    }),
  );
}

/**
 * Refuses an asset path that is not plain relative segments: empty, absolute,
 * backslash or control characters, and any segment starting with "." (so
 * dotfiles, dot-directories, "." and "..").
 */
export function assertAssetPath(path: unknown): asserts path is string {
  const ok =
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1024 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them
    !/[\\\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every((s) => s.length > 0 && !s.startsWith("."));
  if (!ok)
    throw new Error(
      `asset path ${JSON.stringify(String(path)).slice(0, 80)} is not allowed (no dotfile, dot-directory, empty, absolute or backslash segment)`,
    );
}

/** The record's assets list for these files: checked paths, unique, sorted by path. */
export function assetEntries(
  files: readonly ReleaseAsset[],
): ReleaseAssetEntry[] {
  const out = files.map((f) => {
    assertAssetPath(f?.path);
    if (!(f.bytes instanceof Uint8Array))
      throw new Error(`asset ${f.path} has no bytes`);
    return {
      path: f.path,
      size: f.bytes.byteLength,
      sha256: sha256Hex(f.bytes),
    };
  });
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < out.length; i++)
    if (out[i]?.path === out[i - 1]?.path)
      throw new Error(`asset path ${out[i]?.path} appears twice`);
  return out;
}

export const MIGRATION_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

/** sha256 over the sorted lines `name + "\0" + sha256(bytes)`, joined by "\n". */
export function migrationsSha256(files: readonly ReleaseFile[]): string {
  const lines = files.map((f) => {
    if (typeof f?.name !== "string" || !MIGRATION_RE.test(f.name))
      throw new Error(
        `unexpected migration file name ${JSON.stringify(String(f?.name)).slice(0, 80)}`,
      );
    if (!(f.bytes instanceof Uint8Array))
      throw new Error(`migration ${f.name} has no bytes`);
    return `${f.name}\0${sha256Hex(f.bytes)}`;
  });
  lines.sort();
  if (new Set(lines.map((l) => l.split("\0")[0])).size !== lines.length)
    throw new Error("a migration file name appears twice");
  return sha256Hex(lines.join("\n"));
}

/** The bytes the release workflow signs. */
export const releaseRecordPayload = (rec: unknown): Buffer =>
  Buffer.from(canonicalJson(rec));

/** True only for a well-formed Ed25519 signature by `pubkey` over the record. */
export function verifyReleaseSignature(
  signed: unknown,
  pubkey: string,
): signed is SignedReleaseRecord {
  const s = signed as SignedReleaseRecord | null;
  if (
    !s ||
    typeof s !== "object" ||
    !s.record ||
    typeof s.record !== "object" ||
    Array.isArray(s.record) ||
    typeof s.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(s.signature) ||
    typeof pubkey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(pubkey)
  )
    return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: pubkey },
      format: "jwk",
    });
    return verify(
      null,
      releaseRecordPayload(s.record),
      key,
      Buffer.from(s.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * Reads a built assets directory for the release step: regular files only.
 * A symlink, dotfile or dot-directory anywhere is refused, not skipped.
 */
export async function readAssetsDir(dir: string): Promise<ReleaseAsset[]> {
  const out: ReleaseAsset[] = [];
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      assertAssetPath(r);
      const st = await lstat(join(dir, r));
      if (st.isSymbolicLink())
        throw new Error(`asset ${r} is a symlink; refusing to follow it`);
      if (st.isDirectory()) await walk(r);
      else if (st.isFile())
        out.push({
          path: r,
          bytes: new Uint8Array(await readFile(join(dir, r))),
        });
      else throw new Error(`asset ${r} is not a regular file`);
    }
  };
  await walk("");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
