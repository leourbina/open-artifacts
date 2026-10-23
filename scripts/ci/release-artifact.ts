// The hosted release artifact (T3b): what hosted-build writes, hosted-check
// verifies and hosted-sign signs. node:* imports only, on purpose: the
// signing job installs nothing, so this file is its own copy of the hardened
// reader, canonicalJson and the record builder of @oa/provision (a test pins
// identical bytes). Never import a package here.
//
// Artifact layout (paths in manifest.json):
//   release/<module>  redline/<module>  assets/<path>
//   template/wrangler.template.jsonc  migrations/<name>  welcome/welcome.md
// Tar layout (one per env and variant): modules/<module> plus the rest as is.
import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

export type Env = "staging" | "prod";
export type Variant = "release" | "redline";
export type File = { path: string; bytes: Uint8Array };
export type Mod = { name: string; type: "esm" | "wasm"; bytes: Uint8Array };
export type Migration = { name: string; bytes: Uint8Array };

export const MANIFEST = "manifest.json";
export const TEMPLATE_FILE = "template/wrangler.template.jsonc";
export const WELCOME_FILE = "welcome/welcome.md";
export const TEST_HOOKS_DEFINE = "__OA_TEST_HOOKS_ALLOWED__";
export const ASSET_LIMITS = {
  files: 20_000,
  fileBytes: 25 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
} as const;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const MIGRATION_RE = /^\d{4}_[a-z0-9_]+\.sql$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256Hex = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

/** JSON with object keys sorted at every level (as @oa/provision). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v);
}

export function bundleSha256(b: {
  mainModule: string;
  modules: readonly Mod[];
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

export function assertAssetPath(path: unknown): asserts path is string {
  const ok =
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1024 &&
    path
      .split("/")
      .every((s) => /^[A-Za-z0-9._~@+-]+$/.test(s) && !s.startsWith("."));
  if (!ok)
    throw new Error(
      `asset path ${JSON.stringify(String(path)).slice(0, 80)} is not allowed (no dotfile, dot-directory, empty, absolute or backslash segment)`,
    );
}

export function assetEntries(files: readonly File[]) {
  const out = files.map((f) => {
    assertAssetPath(f?.path);
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

export function migrationsSha256(files: readonly Migration[]): string {
  const lines = files.map((f) => {
    if (!MIGRATION_RE.test(f.name))
      throw new Error(
        `unexpected migration file name ${JSON.stringify(f.name).slice(0, 80)}`,
      );
    return `${f.name}\0${sha256Hex(f.bytes)}`;
  });
  lines.sort();
  if (new Set(lines.map((l) => l.split("\0")[0])).size !== lines.length)
    throw new Error("a migration file name appears twice");
  return sha256Hex(lines.join("\n"));
}

const utf8 = new TextEncoder();

/** name <= 100 bytes, or prefix <= 155 and name <= 100 split at "/". */
export function ustarFits(path: string): boolean {
  const b = utf8.encode(path);
  if (b.length <= 100) return true;
  for (let i = b.length - 1; i > 0; i--)
    if (
      b[i] === 0x2f &&
      i <= 155 &&
      b.length - i - 1 <= 100 &&
      b.length - i - 1 > 0
    )
      return true;
  return false;
}

/** The signed record of one variant: the same bytes as @oa/provision buildReleaseRecord. */
export function buildRecord(i: {
  env: Env;
  version: string;
  variant: Variant;
  mainModule: string;
  modules: readonly Mod[];
  assets: readonly File[];
  template: Uint8Array;
  migrations: readonly Migration[];
  welcome: Uint8Array;
}) {
  if (i.env !== "staging" && i.env !== "prod")
    throw new Error(
      `env ${JSON.stringify(String(i.env))} is not staging or prod`,
    );
  if (i.variant !== "release" && i.variant !== "redline")
    throw new Error("variant must be release or redline");
  if (i.env === "prod" && i.variant === "redline")
    throw new Error("the redline bundle is never signed for prod");
  if (typeof i.version !== "string" || !SEMVER.test(i.version))
    throw new Error(
      `version ${JSON.stringify(String(i.version)).slice(0, 40)} is not a release version`,
    );
  const assets = assetEntries(i.assets);
  if (assets.length > ASSET_LIMITS.files)
    throw new Error(`more than ${ASSET_LIMITS.files} assets`);
  let total = 0;
  for (const a of assets) {
    if (a.size > ASSET_LIMITS.fileBytes)
      throw new Error(`asset ${a.path} is over 25 MiB`);
    total += a.size;
    if (!ustarFits(`assets/${a.path}`))
      throw new Error(`asset path ${a.path} does not fit a plain ustar header`);
  }
  if (total > ASSET_LIMITS.totalBytes)
    throw new Error("assets are over 512 MiB in total");
  for (const m of i.modules) {
    assertAssetPath(m.name);
    if (!ustarFits(`modules/${m.name}`))
      throw new Error(`module ${m.name} does not fit a plain ustar header`);
  }
  return {
    env: i.env,
    version: i.version,
    variant: i.variant,
    sha256: bundleSha256(i),
    defines: { [TEST_HOOKS_DEFINE]: i.variant === "redline" },
    assets,
    templateSha256: sha256Hex(i.template),
    migrationsSha256: migrationsSha256(i.migrations),
    welcomeSha256: sha256Hex(i.welcome),
  };
}

/** The signed bytes: "oa-release-v1\n" + env + "\n" + the record string. */
export const recordPayload = (env: Env, record: string): Buffer =>
  Buffer.from(`oa-release-v1\n${env}\n${record}`);

// ---------- the two variants ----------

const DEFINE_ENTRY = (v: "true" | "false") =>
  `${JSON.stringify(TEST_HOOKS_DEFINE)}:${JSON.stringify(v)}`;

/**
 * hosted-build: the two rendered dry-run configs (buildBundle `config`) must
 * be byte-identical once the one define value is normalized: release has
 * the define "false" and redline "true", each exactly once, and nothing else
 * differs. (The bundles themselves differ: esbuild tree-shakes the hooks out
 * of release.)
 */
export function assertSameConfigButDefine(
  release: string,
  redline: string,
): void {
  const count = (s: string, x: string) => s.split(x).length - 1;
  const r = DEFINE_ENTRY("false");
  const d = DEFINE_ENTRY("true");
  if (count(release, r) !== 1 || count(release, d) !== 0)
    throw new Error(
      `the release config must define ${TEST_HOOKS_DEFINE} "false" once`,
    );
  if (count(redline, d) !== 1 || count(redline, r) !== 0)
    throw new Error(
      `the redline config must define ${TEST_HOOKS_DEFINE} "true" once`,
    );
  if (release.replace(r, d) !== redline)
    throw new Error(
      `the release and redline configs differ beyond the ${TEST_HOOKS_DEFINE} define`,
    );
}

/**
 * The mounted hook routes (keep in sync with @oa/shared TEST_HOOKS, as
 * check-no-test-hooks.ts). The release bundle must contain none of them: the
 * real build tree-shakes the hook modules out. ("/__test/" alone does stay,
 * as the route-policy table's "ALL /__test/*" entry.)
 */
export const HOOK_ROUTES = [
  "/__test/session",
  "/__test/otp/latest",
  "/__test/oauth-client",
] as const;

/** Throws if any release module's bytes contain a hook route string. */
export function assertNoHookRoutes(release: readonly Mod[]): void {
  for (const m of release)
    for (const r of HOOK_ROUTES)
      if (Buffer.from(m.bytes).includes(r))
        throw new Error(
          `release module ${m.name} contains the hook route ${r}`,
        );
}

// ---------- plain ustar, from in-memory bytes ----------

const BLOCK = 512;

function header(path: string, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const b = utf8.encode(path);
  let name = b;
  let prefix = new Uint8Array();
  if (b.length > 100) {
    let cut = -1;
    for (let i = b.length - 1; i > 0; i--)
      if (
        b[i] === 0x2f &&
        i <= 155 &&
        b.length - i - 1 <= 100 &&
        b.length - i - 1 > 0
      ) {
        cut = i;
        break;
      }
    if (cut < 0) throw new Error(`${path} does not fit a plain ustar header`);
    prefix = b.subarray(0, cut);
    name = b.subarray(cut + 1);
  }
  const put = (off: number, s: string) => h.set(utf8.encode(s), off);
  h.set(name, 0);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  h.set(prefix, 345);
  h.fill(32, 148, 156);
  let sum = 0;
  for (const x of h) sum += x;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** A plain ustar of regular files, sorted by path; never a pax or GNU header. */
export function packUstar(files: readonly File[]): Uint8Array {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const parts: Uint8Array[] = [];
  for (const [k, f] of sorted.entries()) {
    assertAssetPath(f.path);
    if (k > 0 && sorted[k - 1]?.path === f.path)
      throw new Error(`${f.path} appears twice`);
    if (f.bytes.length > ASSET_LIMITS.fileBytes)
      throw new Error(`${f.path} is over 25 MiB`);
    parts.push(header(f.path, f.bytes.length));
    const data = new Uint8Array(Math.ceil(f.bytes.length / BLOCK) * BLOCK);
    data.set(f.bytes);
    parts.push(data);
  }
  parts.push(new Uint8Array(2 * BLOCK));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------- the hardened reader (as @oa/provision readTreeHardened) ----------

const fileStamp = (st: Stats) => `f:${st.dev}:${st.ino}:${st.size}:${st.nlink}`;
const dirStamp = (st: Stats) => `d:${st.dev}:${st.ino}`;

export async function readTreeHardened(
  dir: string,
  o: { check?: (rel: string) => void; pick?: (rel: string) => boolean } = {},
): Promise<File[]> {
  const check = o.check ?? assertAssetPath;
  const root = await realpath(dir);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const inside = async (p: string, rel: string) => {
    const r = await realpath(p);
    if (r !== root && !r.startsWith(root + sep))
      throw new Error(`${rel} resolves outside ${dir} (symlink)`);
  };
  const openNoFollow = async (p: string, rel: string, extra: number) => {
    try {
      return await open(p, flags | extra);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ELOOP" || code === "EMLINK")
        throw new Error(`${rel} is a symlink; refusing to follow it`);
      throw err;
    }
  };
  const walk = async (read: boolean) => {
    const seen = new Map<string, string>();
    const out: File[] = [];
    const visit = async (rel: string): Promise<void> => {
      const p = rel ? join(root, rel) : root;
      const dh = await openNoFollow(p, rel || ".", constants.O_DIRECTORY);
      let entries: Dirent[];
      try {
        const st = await dh.stat();
        if (!st.isDirectory()) throw new Error(`${rel} is not a directory`);
        await inside(p, rel || ".");
        entries = await readdir(p, { withFileTypes: true });
        if (dirStamp(await lstat(p)) !== dirStamp(st))
          throw new Error(`${dir}: the tree changed while it was read`);
        seen.set(`${rel}/`, dirStamp(st));
      } finally {
        await dh.close();
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (o.pick && !o.pick(r)) continue;
        check(r);
        if (e.isSymbolicLink())
          throw new Error(`${r} is a symlink; refusing to follow it`);
        if (e.isDirectory()) {
          await visit(r);
          continue;
        }
        if (!e.isFile()) throw new Error(`${r} is not a regular file`);
        const q = join(root, r);
        const fh = await openNoFollow(q, r, constants.O_NONBLOCK);
        try {
          const st = await fh.stat();
          if (!st.isFile()) throw new Error(`${r} is not a regular file`);
          if (st.nlink > 1)
            throw new Error(
              `${r} has ${st.nlink} links (hardlink); refusing it`,
            );
          await inside(q, r);
          seen.set(r, fileStamp(st));
          if (read) {
            const bytes = new Uint8Array(await fh.readFile());
            if (bytes.byteLength !== st.size)
              throw new Error(`${dir}: the tree changed while it was read`);
            out.push({ path: r, bytes });
          }
        } finally {
          await fh.close();
        }
      }
    };
    await visit("");
    return { seen, out };
  };
  const first = await walk(true);
  const second = await walk(false);
  const same =
    first.seen.size === second.seen.size &&
    [...first.seen].every(([k, v]) => second.seen.get(k) === v);
  if (!same) throw new Error(`${dir}: the tree changed while it was read`);
  return first.out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ---------- the artifact ----------

/** What each variant was built from (hosted-guard's commit, the lockfile). */
export interface VariantInfo {
  bundleSha256: string;
  /** The hosted-guard commit SHA the build ran on. */
  commit: string;
  /** sha256 of pnpm-lock.yaml at that build. */
  lockfileSha256: string;
}

export interface Manifest {
  version: string;
  mainModule: string;
  files: { path: string; size: number; sha256: string }[];
  variants: Record<Variant, VariantInfo>;
}

export interface Artifact {
  manifest: Manifest;
  manifestSha256: string;
  release: Mod[];
  redline: Mod[];
  assets: File[];
  template: Uint8Array;
  migrations: Migration[];
  welcome: Uint8Array;
}

const modType = (name: string): Mod["type"] => {
  if (name.endsWith(".wasm")) return "wasm";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "esm";
  throw new Error(`module ${name} is not .js, .mjs or .wasm`);
};

/** hosted-build: writes the artifact and its manifest.json; returns the manifest's sha256. */
export async function writeArtifact(
  out: string,
  a: {
    version: string;
    mainModule: string;
    release: readonly Mod[];
    redline: readonly Mod[];
    assets: readonly File[];
    template: Uint8Array;
    migrations: readonly Migration[];
    welcome: Uint8Array;
    built: Record<Variant, { commit: string; lockfileSha256: string }>;
  },
): Promise<{ manifestSha256: string; bundleSha256: Record<Variant, string> }> {
  const files: File[] = [
    ...a.release.map((m) => ({ path: `release/${m.name}`, bytes: m.bytes })),
    ...a.redline.map((m) => ({ path: `redline/${m.name}`, bytes: m.bytes })),
    ...a.assets.map((f) => ({ path: `assets/${f.path}`, bytes: f.bytes })),
    { path: TEMPLATE_FILE, bytes: a.template },
    ...a.migrations.map((f) => ({
      path: `migrations/${f.name}`,
      bytes: f.bytes,
    })),
    { path: WELCOME_FILE, bytes: a.welcome },
  ];
  for (const f of files) {
    assertAssetPath(f.path);
    const p = join(out, f.path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.bytes, { flag: "wx" });
  }
  const bundle = {
    release: bundleSha256({ mainModule: a.mainModule, modules: a.release }),
    redline: bundleSha256({ mainModule: a.mainModule, modules: a.redline }),
  };
  const manifest: Manifest = {
    version: a.version,
    mainModule: a.mainModule,
    files: assetEntries(files),
    variants: {
      release: { bundleSha256: bundle.release, ...a.built.release },
      redline: { bundleSha256: bundle.redline, ...a.built.redline },
    },
  };
  const bytes = utf8.encode(canonicalJson(manifest));
  await writeFile(join(out, MANIFEST), bytes, { flag: "wx" });
  return { manifestSha256: sha256Hex(bytes), bundleSha256: bundle };
}

/**
 * Reads the artifact with the hardened reader and re-hashes every file:
 * the set of files must be exactly manifest.json's, each with its size and
 * sha256, and each bundleSha256 must match its modules.
 */
export async function readArtifact(dir: string): Promise<Artifact> {
  const files = await readTreeHardened(dir);
  const mf = files.find((f) => f.path === MANIFEST);
  if (!mf) throw new Error(`no ${MANIFEST} in ${dir}`);
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(mf.bytes),
  ) as Manifest;
  if (canonicalJson(manifest) !== new TextDecoder().decode(mf.bytes))
    throw new Error(`${MANIFEST} is not canonical JSON`);
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version))
    throw new Error(`${MANIFEST} has no valid version`);
  if (!Array.isArray(manifest.files))
    throw new Error(`${MANIFEST} has no files list`);
  const rest = files.filter((f) => f !== mf);
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  if (listed.size !== manifest.files.length || listed.size !== rest.length)
    throw new Error(
      `the artifact's files are not exactly ${MANIFEST}'s (an extra or missing file)`,
    );
  const a: Artifact = {
    manifest,
    manifestSha256: sha256Hex(mf.bytes),
    release: [],
    redline: [],
    assets: [],
    template: new Uint8Array(),
    migrations: [],
    welcome: new Uint8Array(),
  };
  let template = false;
  let welcome = false;
  for (const f of rest) {
    const m = listed.get(f.path);
    if (
      !m ||
      !HEX64.test(m.sha256) ||
      m.size !== f.bytes.length ||
      m.sha256 !== sha256Hex(f.bytes)
    )
      throw new Error(`${f.path} does not match ${MANIFEST}`);
    const [top, ...tail] = f.path.split("/");
    const name = tail.join("/");
    if (f.path === TEMPLATE_FILE) {
      a.template = f.bytes;
      template = true;
    } else if (f.path === WELCOME_FILE) {
      a.welcome = f.bytes;
      welcome = true;
    } else if ((top === "release" || top === "redline") && name)
      a[top].push({ name, type: modType(name), bytes: f.bytes });
    else if (top === "assets" && name)
      a.assets.push({ path: name, bytes: f.bytes });
    else if (top === "migrations" && MIGRATION_RE.test(name))
      a.migrations.push({ name, bytes: f.bytes });
    else throw new Error(`unexpected file ${f.path} in the artifact`);
  }
  if (!template || !welcome)
    throw new Error("the artifact has no template or welcome");
  for (const v of ["release", "redline"] as const) {
    const info = manifest.variants?.[v];
    if (
      !info ||
      bundleSha256({ mainModule: manifest.mainModule, modules: a[v] }) !==
        info.bundleSha256
    )
      throw new Error(
        `the ${v} modules do not match ${MANIFEST}'s bundleSha256`,
      );
    if (!/^[0-9a-f]{40}$/.test(info.commit) || !HEX64.test(info.lockfileSha256))
      throw new Error(
        `${MANIFEST} has no valid ${v} commit or lockfile sha256`,
      );
  }
  return a;
}

export interface Prepared {
  env: Env;
  variant: Variant;
  version: string;
  recordString: string;
  recordSha256: string;
  tar: Uint8Array;
  tarSha256: string;
  /** oa-release-<env>-<variant>-<version> */
  base: string;
}

/**
 * hosted-sign (and hosted-attach): from the verified artifact, the record and
 * tar of every variant the env takes. Requires hosted-check's outputs (the
 * manifest's sha256 and the release bundleSha256 it checked); both variants
 * built from hosted-guard's commit with the same lockfile (the one checked
 * out here); no /__test/ route in release; defines false for release and
 * true for redline (redline only for staging).
 */
export function prepare(
  a: Artifact,
  o: {
    env: Env;
    version: string;
    manifestSha256: string;
    bundleSha256: string;
    /** hosted-guard's commit SHA. */
    commit: string;
    /** sha256 of the checked-out pnpm-lock.yaml. */
    lockfileSha256: string;
  },
): Prepared[] {
  if (o.env !== "staging" && o.env !== "prod")
    throw new Error("env must be staging or prod");
  if (!HEX64.test(o.manifestSha256) || o.manifestSha256 !== a.manifestSha256)
    throw new Error(`${MANIFEST} is not the one hosted-check verified`);
  const release = bundleSha256({
    mainModule: a.manifest.mainModule,
    modules: a.release,
  });
  if (!HEX64.test(o.bundleSha256) || o.bundleSha256 !== release)
    throw new Error("the release bundle is not the one hosted-check ran");
  if (o.version !== a.manifest.version)
    throw new Error(
      `version ${o.version} is not the artifact's ${a.manifest.version}`,
    );
  const { release: rv, redline: dv } = a.manifest.variants;
  if (rv.commit !== dv.commit)
    throw new Error(
      "the release and redline builds are from different commits",
    );
  if (rv.lockfileSha256 !== dv.lockfileSha256)
    throw new Error("the release and redline builds used different lockfiles");
  if (!/^[0-9a-f]{40}$/.test(o.commit) || rv.commit !== o.commit)
    throw new Error(
      `the builds are not from hosted-guard's commit ${o.commit.slice(0, 40)}`,
    );
  if (!HEX64.test(o.lockfileSha256) || rv.lockfileSha256 !== o.lockfileSha256)
    throw new Error(
      "the builds' lockfile is not the checked-out pnpm-lock.yaml",
    );
  assertNoHookRoutes(a.release);
  const variants: Variant[] =
    o.env === "prod" ? ["release"] : ["release", "redline"];
  return variants.map((variant) => {
    const modules = a[variant];
    const record = buildRecord({
      env: o.env,
      version: o.version,
      variant,
      mainModule: a.manifest.mainModule,
      modules,
      assets: a.assets,
      template: a.template,
      migrations: a.migrations,
      welcome: a.welcome,
    });
    if (record.defines[TEST_HOOKS_DEFINE] !== (variant === "redline"))
      throw new Error(
        `${TEST_HOOKS_DEFINE} must be ${variant === "redline"} for ${variant}`,
      );
    const recordString = canonicalJson(record);
    // Packed from the bytes just hashed into the record, never re-read.
    const tar = packUstar([
      ...modules.map((m) => ({ path: `modules/${m.name}`, bytes: m.bytes })),
      ...a.assets.map((f) => ({ path: `assets/${f.path}`, bytes: f.bytes })),
      { path: TEMPLATE_FILE, bytes: a.template },
      ...a.migrations.map((f) => ({
        path: `migrations/${f.name}`,
        bytes: f.bytes,
      })),
      { path: WELCOME_FILE, bytes: a.welcome },
    ]);
    return {
      env: o.env,
      variant,
      version: o.version,
      recordString,
      recordSha256: sha256Hex(recordString),
      tar,
      tarSha256: sha256Hex(tar),
      base: `oa-release-${o.env}-${variant}-${o.version}`,
    };
  });
}

/** sha256 of one file (pnpm-lock.yaml), read with the hardened reader. */
export async function fileSha256(path: string): Promise<string> {
  const name = basename(path);
  const [f] = await readTreeHardened(dirname(path), {
    pick: (r) => r === name,
  });
  if (!f) throw new Error(`${path} is missing`);
  return sha256Hex(f.bytes);
}

/** The .sig.json bytes: the stored form { record, signature }. */
export const sigJson = (p: Prepared, signature: string): Uint8Array =>
  utf8.encode(JSON.stringify({ record: p.recordString, signature }));

/** Parses --flag value pairs; refuses any flag not in `known` and any repeat. */
export function parseArgs(
  argv: readonly string[],
  known: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i] as string;
    const v = argv[i + 1];
    if (
      !k.startsWith("--") ||
      !known.includes(k.slice(2)) ||
      v === undefined ||
      Object.hasOwn(out, k.slice(2))
    )
      throw new Error(`unexpected argument ${JSON.stringify(k).slice(0, 40)}`);
    out[k.slice(2)] = v;
  }
  return out;
}
