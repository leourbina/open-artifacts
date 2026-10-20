// Demo data reset: replaces each listed artifact's live data with a seed
// snapshot, through the owner-only PUT /api/v1/artifacts/:id/data
// (R.dataReset), which swaps all docs atomically and makes live viewers refetch.
//
// Usage:
//   node scripts/demo/reset.ts <seed.json> --base-url https://artifacts.example.com \
//     [--token-file <path>] [--apply]
//
// - seed.json: { "<artifactId>": { "collections": { "<collection>": { "<docId>": <doc> } } } }
// - --base-url (or OA_URL): the instance's app origin.
// - Token: a PAT of the artifacts' owner, read from --token-file (first line)
//   or OA_TOKEN. It is only ever sent as the Authorization header: never
//   printed, logged or echoed in errors.
// - Dry run by default: validates the seed and prints what each artifact would
//   get (collections, docs, bytes). --apply performs the resets, one request
//   per artifact. A reset is idempotent: re-running with the same seed is safe.
// - Exit code: 0 if every artifact succeeded (or the dry run is valid), else 1.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Snapshot = { collections: Record<string, Record<string, unknown>> };
export type Seed = Record<string, Snapshot>;
export type Options = {
  seedPath: string;
  baseUrl: string;
  tokenFile?: string;
  apply: boolean;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The seed, or throws with every problem found (the server re-validates). */
export function parseSeed(text: string): Seed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`seed is not JSON: ${(e as Error).message}`);
  }
  if (!isObj(raw))
    throw new Error("seed must be an object of artifactId → { collections }");
  const errs: string[] = [];
  for (const [id, snap] of Object.entries(raw)) {
    if (!ID_RE.test(id)) errs.push(`${id}: invalid artifact id`);
    if (
      !isObj(snap) ||
      Object.keys(snap).join() !== "collections" ||
      !isObj(snap.collections)
    ) {
      errs.push(`${id}: must be { "collections": { ... } }`);
      continue;
    }
    for (const [col, docs] of Object.entries(snap.collections)) {
      if (!NAME_RE.test(col)) errs.push(`${id}: invalid collection "${col}"`);
      if (!isObj(docs)) {
        errs.push(`${id}/${col}: must be an object of docId → doc`);
        continue;
      }
      for (const doc of Object.keys(docs))
        if (!NAME_RE.test(doc))
          errs.push(`${id}/${col}: invalid doc id "${doc}"`);
    }
  }
  if (errs.length) throw new Error(`invalid seed:\n  ${errs.join("\n  ")}`);
  return raw as Seed;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  let seedPath: string | undefined;
  let baseUrl = env.OA_URL;
  let tokenFile: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--base-url") baseUrl = argv[++i];
    else if (a === "--token-file") tokenFile = argv[++i];
    else if (a?.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (seedPath === undefined) seedPath = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!seedPath)
    throw new Error(
      "usage: reset.ts <seed.json> --base-url <url> [--token-file <path>] [--apply]",
    );
  if (!baseUrl) throw new Error("missing --base-url (or OA_URL)");
  const u = new URL(baseUrl);
  if (
    u.protocol !== "https:" &&
    u.hostname !== "localhost" &&
    u.hostname !== "127.0.0.1"
  )
    throw new Error("--base-url must be https (or localhost)");
  return { seedPath, baseUrl: u.origin, tokenFile, apply };
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

const count = (s: Snapshot) =>
  Object.values(s.collections).reduce((n, d) => n + Object.keys(d).length, 0);

/** Runs the reset; returns the exit code. `log` gets every output line. */
export async function run(
  o: Options,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const seed = parseSeed(readFileSync(o.seedPath, "utf8"));
  const token = o.apply ? readToken(o, env) : "";
  const scrub = (s: string) => (token ? s.split(token).join("<token>") : s);
  let failed = 0;
  for (const [id, snap] of Object.entries(seed)) {
    const body = JSON.stringify(snap);
    const what = `${id}: ${Object.keys(snap.collections).length} collections, ${count(snap)} docs, ${Buffer.byteLength(body)} bytes`;
    if (!o.apply) {
      log(`would reset ${what}`);
      continue;
    }
    try {
      const r = await fetchFn(
        `${o.baseUrl}/api/v1/artifacts/${encodeURIComponent(id)}/data`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body,
        },
      );
      const text = await r.text();
      if (r.ok) log(`reset ${what} → ${scrub(text)}`);
      else {
        failed++;
        log(`FAILED ${id}: HTTP ${r.status} ${scrub(text).slice(0, 500)}`);
      }
    } catch (e) {
      failed++;
      log(`FAILED ${id}: ${scrub(String((e as Error).message ?? e))}`);
    }
  }
  if (!o.apply) log("dry run: nothing changed; pass --apply to reset");
  return failed ? 1 : 0;
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
