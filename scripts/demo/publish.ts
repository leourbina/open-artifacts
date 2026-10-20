// Publishes the demo artifacts from the repo (ops/demo) to a demo instance.
//
// Usage:
//   node scripts/demo/publish.ts --base-url https://demo.example.com \
//     [--token-file <path>] [--demo-dir ops/demo] [--apply]
//   node scripts/demo/publish.ts --write-seed <out.json> [--demo-dir ops/demo]
//
// - ops/demo/publish.json { "approved": [slug] }: only these slugs are ever published.
//   `gallery` goes last.
// - ops/demo/artifacts/<slug>/ (manifest.json + files), ops/demo/seed/<slug>.json,
//   ops/demo/ids.json { slug: artifactId } (Platform-owned).
// - `{{id:<slug>}}` in a text file becomes that approved slug's id from ids.json;
//   unknown or unapproved slugs are left untouched. The substituted text is part of
//   the content hash, stored in the version message as `src:<sha256>`: an unchanged
//   hash is skipped.
// - A slug with an id publishes a new version. A slug without one fails fast, before any
//   request, unless --create is given: then it is created, printed as `NEW <slug> <id>`
//   and the run fails (commit ids.json). A missing publish.json approves nothing.
// - Only an artifact created in this run is seeded (owner PUT /api/v1/artifacts/:id/data).
//   Existing artifacts are never seeded here: the nightly reset does it. --write-seed
//   builds the reset's input from the same per-slug seeds (one source of truth).
// - Symlinks anywhere under artifacts/ are refused; dotfiles are skipped.
// - Dry run by default (no network). The token is read from --token-file or OA_TOKEN,
//   sent only as the Authorization header, and scrubbed from every output line.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TEXT_EXT = /\.(html?|css|m?js|json|svg|txt|md|map|xml|webmanifest)$/i;
const INLINE_BUDGET = 100 * 1024; // the server's inline limit is 128 KB in total
const VISIBILITY = ["public", "team", "private"];
const MANIFEST_KEYS = [
  "title",
  "visibility",
  "allowAnonymousWrites",
  "capabilities",
  "description",
];
const CAP_KEYS = ["db", "viewer", "storage"];
const defaultDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../ops/demo",
);

export type Options = {
  demoDir: string;
  baseUrl: string;
  tokenFile?: string;
  apply: boolean;
  /** Allow creating artifacts for slugs with no id (manual runs only). */
  create?: boolean;
  writeSeed?: string;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every problem with a manifest (empty when valid). */
export function validateManifest(m: unknown): string[] {
  if (!isObj(m)) return ["manifest must be an object"];
  const errs: string[] = [];
  for (const k of Object.keys(m))
    if (!MANIFEST_KEYS.includes(k)) errs.push(`unknown key "${k}"`);
  const t = m.title;
  if (typeof t !== "string" || t.trim().length < 1 || t.trim().length > 200)
    errs.push("title must be a string of 1-200 characters");
  if (!VISIBILITY.includes(m.visibility as string))
    errs.push(`visibility must be one of ${VISIBILITY.join("|")}`);
  if (
    m.allowAnonymousWrites !== undefined &&
    typeof m.allowAnonymousWrites !== "boolean"
  )
    errs.push("allowAnonymousWrites must be a boolean");
  if (
    m.description !== undefined &&
    (typeof m.description !== "string" || m.description.length > 2000)
  )
    errs.push("description must be a string of at most 2000 characters");
  if (m.capabilities !== undefined) {
    const c = m.capabilities;
    if (
      !isObj(c) ||
      Object.entries(c).some(
        ([k, v]) => !CAP_KEYS.includes(k) || typeof v !== "boolean",
      )
    )
      errs.push("capabilities must be { db?, viewer?, storage? } booleans");
  }
  return errs;
}

/** `{{id:<slug>}}` → that slug's id, for approved slugs that have one. */
export function substitute(
  text: string,
  ids: Record<string, string>,
  approved: string[],
): string {
  return text.replace(/\{\{id:([a-z0-9-]+)\}\}/g, (whole, slug: string) =>
    approved.includes(slug) && ids[slug] ? (ids[slug] as string) : whole,
  );
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

function readApproved(dir: string): string[] {
  const pj = join(dir, "publish.json");
  if (!existsSync(pj)) return []; // owned by the demo artifacts change; absent = nothing approved
  const j = readJson(pj);
  const a = isObj(j) ? j.approved : undefined;
  if (
    !Array.isArray(a) ||
    a.some((s) => typeof s !== "string" || !SLUG_RE.test(s))
  )
    throw new Error("publish.json: approved must be a list of slugs");
  return a as string[];
}

function readIds(dir: string): Record<string, string> {
  const p = join(dir, "ids.json");
  if (!existsSync(p)) return {};
  const j = readJson(p);
  if (!isObj(j)) throw new Error("ids.json must be an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(j)) {
    if (typeof v !== "string" || !ID_RE.test(v) || !SLUG_RE.test(k))
      throw new Error(`ids.json: bad entry "${k}"`);
    out[k] = v;
  }
  return out;
}

type SlugSeed = { collections: Record<string, Record<string, unknown>> };

/** The slug's seed, or undefined when it has no docs to seed. */
function readSeed(dir: string, slug: string): SlugSeed | undefined {
  const p = join(dir, "seed", `${slug}.json`);
  if (!existsSync(p)) return undefined;
  if (lstatSync(p).isSymbolicLink())
    throw new Error(`seed/${slug}.json is a symlink`);
  const j = readJson(p);
  const c = isObj(j) ? j.collections : undefined;
  if (!isObj(c))
    throw new Error(`seed/${slug}.json: collections must be an object`);
  const collections: SlugSeed["collections"] = {};
  for (const [col, docs] of Object.entries(c)) {
    if (!NAME_RE.test(col) || !isObj(docs))
      throw new Error(`seed/${slug}.json: bad collection "${col}"`);
    for (const d of Object.keys(docs))
      if (!NAME_RE.test(d))
        throw new Error(`seed/${slug}.json: bad doc id "${d}"`);
    if (Object.keys(docs).length) collections[col] = docs;
  }
  return Object.keys(collections).length ? { collections } : undefined;
}

/** The reset's input: `{ <artifactId>: { collections } }` for every approved slug with an id. */
export function buildSeed(dir: string): Record<string, SlugSeed> {
  const ids = readIds(dir);
  const out: Record<string, SlugSeed> = {};
  for (const slug of readApproved(dir)) {
    const id = ids[slug];
    if (!id) continue;
    const seed = readSeed(dir, slug);
    if (seed) {
      out[id] = seed;
      continue;
    }
    // A db artifact with no seed is reset to empty, so anonymous writes do not pile up.
    const m = readJson(join(dir, "artifacts", slug, "manifest.json"));
    if (isObj(m) && isObj(m.capabilities) && m.capabilities.db === true)
      out[id] = { collections: {} };
  }
  return out;
}

type FileData = { path: string; bytes: Buffer; text: boolean };

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink())
        throw new Error(`${relative(root, p)} is a symlink; refusing`);
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** The settings an artifact must have, with every default explicit. */
function settingsOf(m: Record<string, unknown>) {
  const c = (m.capabilities ?? {}) as Record<string, unknown>;
  return {
    title: m.title as string,
    description: (m.description as string | undefined) ?? "",
    visibility: m.visibility as string,
    capabilities: {
      db: c.db === true,
      viewer: c.viewer === true,
      storage: c.storage === true,
    },
    allowAnonymousWrites: m.allowAnonymousWrites === true,
  };
}
type Settings = ReturnType<typeof settingsOf>;

type Plan = {
  slug: string;
  manifest: Record<string, unknown>;
  settings: Settings;
  files: FileData[];
  hash: string;
};

function plan(
  dir: string,
  slug: string,
  ids: Record<string, string>,
  approved: string[],
): Plan {
  // lstat every component from ops/demo/artifacts down: no symlinks anywhere.
  const base = join(dir, "artifacts");
  const root = join(base, slug);
  for (const p of [base, root]) {
    if (!existsSync(p))
      throw new Error(`${slug}: no artifacts/${slug} directory`);
    const st = lstatSync(p);
    if (st.isSymbolicLink())
      throw new Error(`${slug}: ${relative(dir, p)} is a symlink; refusing`);
    if (!st.isDirectory())
      throw new Error(`${slug}: ${relative(dir, p)} is not a directory`);
  }
  const mp = join(root, "manifest.json");
  if (!existsSync(mp)) throw new Error(`${slug}: manifest.json is missing`);
  if (lstatSync(mp).isSymbolicLink())
    throw new Error(`${slug}: manifest.json is a symlink; refusing`);
  const manifest = readJson(mp);
  const errs = validateManifest(manifest);
  if (errs.length) throw new Error(`${slug}: ${errs.join("; ")}`);
  const m = manifest as Record<string, unknown>;
  const files: FileData[] = [];
  for (const abs of listFiles(root)) {
    const path = relative(root, abs).split(sep).join("/");
    if (path === "manifest.json") continue;
    const raw = readFileSync(abs);
    const text = TEXT_EXT.test(path);
    files.push({
      path,
      text,
      bytes: text
        ? Buffer.from(substitute(raw.toString("utf8"), ids, approved))
        : raw,
    });
  }
  if (!files.some((f) => f.path === "index.html"))
    throw new Error(`${slug}: index.html is missing`);
  const settings = settingsOf(m);
  const h = createHash("sha256");
  h.update(JSON.stringify(settings));
  for (const f of files)
    h.update(
      `\0${f.path}\0${createHash("sha256").update(f.bytes).digest("hex")}`,
    );
  return { slug, manifest: m, settings, files, hash: h.digest("hex") };
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  let baseUrl = env.OA_URL;
  let tokenFile: string | undefined;
  let demoDir = defaultDir;
  let apply = false;
  let writeSeed: string | undefined;
  let create = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--create") create = true;
    else if (a === "--base-url") baseUrl = argv[++i];
    else if (a === "--token-file") tokenFile = argv[++i];
    else if (a === "--demo-dir") demoDir = argv[++i] ?? demoDir;
    else if (a === "--write-seed") writeSeed = argv[++i];
    else
      throw new Error(
        a?.startsWith("--")
          ? `unknown option ${a}`
          : `unexpected argument ${a}`,
      );
  }
  if (writeSeed) return { demoDir, baseUrl: "", apply: false, writeSeed };
  if (!baseUrl) throw new Error("missing --base-url (or OA_URL)");
  const u = new URL(baseUrl);
  if (
    u.protocol !== "https:" &&
    u.hostname !== "localhost" &&
    u.hostname !== "127.0.0.1"
  )
    throw new Error("--base-url must be https (or localhost)");
  return { demoDir, baseUrl: u.origin, tokenFile, apply, create };
}

function readToken(o: Options, env: NodeJS.ProcessEnv): string {
  const t = (
    o.tokenFile
      ? readFileSync(o.tokenFile, "utf8").split(/\r?\n/)[0]
      : env.OA_TOKEN
  )?.trim();
  if (!t) throw new Error("no token: pass --token-file <path> or set OA_TOKEN");
  return t;
}

const order = (slugs: string[]) => [
  ...slugs.filter((s) => s !== "gallery"),
  ...slugs.filter((s) => s === "gallery"),
];

/** Runs the publish; returns the exit code. `log` gets every output line. */
export async function run(
  o: Options,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  if (o.writeSeed) {
    const seed = buildSeed(o.demoDir);
    writeFileSync(o.writeSeed, `${JSON.stringify(seed, null, 2)}\n`);
    log(`wrote seed for ${Object.keys(seed).length} artifacts`);
    return 0;
  }
  const approved = readApproved(o.demoDir);
  const ids = readIds(o.demoDir);
  const token = o.apply ? readToken(o, env) : "";
  const scrub = (s: string) => (token ? s.split(token).join("<token>") : s);
  let failed = 0;
  const fail = (msg: string) => {
    failed++;
    log(`FAILED ${scrub(msg)}`);
  };

  // Validate everything before touching the network.
  const plans: Plan[] = [];
  for (const slug of order(approved)) {
    try {
      plans.push(plan(o.demoDir, slug, ids, approved));
    } catch (e) {
      fail((e as Error).message);
    }
  }
  if (o.apply && !o.create)
    for (const p of plans)
      if (!ids[p.slug])
        fail(
          `slug ${p.slug} has no id; run Demo publish with create=true, then commit ids.json`,
        );
  if (failed) return 1;
  if (!o.apply) {
    for (const p of plans)
      log(
        `would ${ids[p.slug] ? "publish" : "create"} ${p.slug} (${p.files.length} files)`,
      );
    log("dry run: nothing changed; pass --apply to publish");
    return 0;
  }

  const call = async (
    method: string,
    url: string,
    body?: unknown,
    auth = true,
  ) => {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) payload = body as BodyInit;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const r = await fetchFn(url, { method, headers, body: payload });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as unknown) : null;
  };
  const api = (p: string) => `${o.baseUrl}${p}`;
  const needNew: string[] = [];

  for (const p of plans) {
    try {
      let id = ids[p.slug];
      if (id) {
        const versions = (await call(
          "GET",
          api(`/api/v1/artifacts/${encodeURIComponent(id)}/versions`),
        )) as { message?: string | null }[];
        if (versions[0]?.message === `src:${p.hash}`) {
          const live = (await call(
            "GET",
            api(`/api/v1/artifacts/${encodeURIComponent(id)}`),
          )) as {
            visibility?: string;
            capabilities?: Record<string, boolean>;
            allowAnonymousWrites?: boolean;
          };
          const want = p.settings;
          const same =
            live.visibility === want.visibility &&
            live.allowAnonymousWrites === want.allowAnonymousWrites &&
            (["db", "viewer", "storage"] as const).every(
              (k) => (live.capabilities?.[k] ?? false) === want.capabilities[k],
            );
          if (same) {
            log(`unchanged ${p.slug}`);
            continue;
          }
          log(`settings drifted for ${p.slug}; republishing`);
        }
      }
      const m = p.manifest;
      const files: Record<string, unknown> = {};
      let inline = 0;
      const bySize = [...p.files].sort(
        (a, b) => b.bytes.length - a.bytes.length,
      );
      const encoded = (f: FileData) =>
        f.text
          ? f.bytes.toString("utf8")
          : { base64: f.bytes.toString("base64") };
      for (const f of p.files) inline += f.bytes.length * (f.text ? 1 : 1.4);
      const upload = new Set<string>();
      for (const f of bySize) {
        if (inline <= INLINE_BUDGET) break;
        upload.add(f.path);
        inline -= f.bytes.length * (f.text ? 1 : 1.4);
      }
      for (const f of p.files) {
        if (!upload.has(f.path)) {
          files[f.path] = encoded(f);
          continue;
        }
        const u = (await call("POST", api("/api/v1/uploads"), {
          ...(id ? { artifactId: id } : {}),
          path: f.path,
          size: f.bytes.length,
        })) as { uploadId: string; artifactId: string; url: string };
        id ??= u.artifactId;
        await call("PUT", u.url, new Uint8Array(f.bytes), false);
        files[f.path] = { uploadId: u.uploadId };
      }
      const body = {
        ...(id ? { id } : {}),
        title: m.title,
        ...(m.description !== undefined ? { description: m.description } : {}),
        format: "html",
        entry: "index.html",
        files,
        visibility: p.settings.visibility,
        capabilities: p.settings.capabilities,
        allowAnonymousWrites: p.settings.allowAnonymousWrites,
        message: `src:${p.hash}`,
      };
      const existing = ids[p.slug] !== undefined;
      const res = (await call(
        "POST",
        existing
          ? api(
              `/api/v1/artifacts/${encodeURIComponent(id as string)}/versions`,
            )
          : api("/api/v1/artifacts"),
        body,
      )) as { id: string; version: number };
      log(`published ${p.slug} ${res.id} v${res.version}`);
      if (!existing) {
        log(`NEW ${p.slug} ${res.id}`);
        needNew.push(p.slug);
      }
      id = res.id;

      // Only an artifact created in this run is seeded; the nightly reset handles the rest.
      const seed = existing ? undefined : readSeed(o.demoDir, p.slug);
      if (seed) {
        await call(
          "PUT",
          api(`/api/v1/artifacts/${encodeURIComponent(id)}/data`),
          seed,
        );
        log(`seeded ${p.slug}`);
      }
    } catch (e) {
      fail(`${p.slug}: ${(e as Error).message}`);
    }
  }
  if (needNew.length)
    log(
      `FAILED new artifacts were created for ${needNew.join(", ")}: commit ids.json with the NEW ids above`,
    );
  return failed || needNew.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const o = parseArgs(process.argv.slice(2), process.env);
    process.exitCode = await run(o, process.env, (l) => console.log(l));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
