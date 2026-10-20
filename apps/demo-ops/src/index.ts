/**
 * Demo ops Worker: once a minute, read activity from the demo source artifacts and
 * write an aggregate into the dashboard artifact (collection `stats`, doc `summary`)
 * through the owner API. It serves nothing (fetch is always 404) and reads only ids in
 * SOURCE_ARTIFACT_IDS. It never calls PUT /data (the atomic reset).
 */
import { isId } from "@oa/shared";

export interface Env {
  /** Secret: owner PAT for the demo instance. Never logged. */
  DEMO_OA_TOKEN: string;
  DEMO_BASE_URL: string;
  DASHBOARD_ARTIFACT_ID: string;
  /** Comma-separated artifact ids (at most 10). */
  SOURCE_ARTIFACT_IDS: string;
  /** Comma-separated collection names read from each source (at most 5). */
  SOURCE_COLLECTIONS: string;
}

/** TODO: Frontend and Design define the real dashboard schema; keep this minimal. */
export interface DemoAggregate {
  /** Docs per source artifact id (summed over SOURCE_COLLECTIONS; saturates at the page cap). */
  counts: Record<string, number>;
  updatedAt: string;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_IDS = 10;
const MAX_COLLECTIONS = 5;
const PAGE_LIMIT = 200;
const MAX_PAGES = 2;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;

const parseList = (
  raw: string,
  ok: (s: string) => boolean,
  max: number,
  what: string,
): string[] => {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v) continue;
    if (!ok(v)) {
      console.warn(`demo-ops: ignoring invalid ${what}`);
      continue;
    }
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, max);
};

/** The JSON body, or throws when it is over MAX_BYTES (declared or read). */
async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BYTES) throw new Error("response too large");
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

const init = (env: Env, method: string, body?: string): RequestInit => ({
  method,
  headers: {
    authorization: `Bearer ${env.DEMO_OA_TOKEN}`,
    "content-type": "application/json",
  },
  signal: AbortSignal.timeout(TIMEOUT_MS),
  ...(body === undefined ? {} : { body }),
});

/** Docs in one collection: up to MAX_PAGES pages of PAGE_LIMIT. */
async function countCollection(
  env: Env,
  base: string,
  id: string,
  col: string,
): Promise<number> {
  let n = 0;
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = `limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(
      `${base}/api/v1/artifacts/${id}/data/${col}?${q}`,
      init(env, "GET"),
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    const page = (await readJson(res)) as {
      items?: unknown[];
      nextCursor?: string | null;
    } | null;
    n += Array.isArray(page?.items) ? page.items.length : 0;
    cursor = page?.nextCursor ?? null;
    if (!cursor) break;
  }
  return n;
}

async function tick(env: Env): Promise<void> {
  const ids = parseList(env.SOURCE_ARTIFACT_IDS, isId, MAX_IDS, "source id");
  const cols = parseList(
    env.SOURCE_COLLECTIONS,
    (s) => NAME_RE.test(s),
    MAX_COLLECTIONS,
    "collection",
  );
  if (!ids.length || !cols.length) return;
  if (!isId(env.DASHBOARD_ARTIFACT_ID)) {
    console.error("demo-ops: invalid DASHBOARD_ARTIFACT_ID");
    return;
  }
  const base = env.DEMO_BASE_URL.replace(/\/+$/, "");
  const counts: Record<string, number> = {};
  for (const id of ids) {
    try {
      let total = 0;
      for (const col of cols)
        total += await countCollection(env, base, id, col);
      counts[id] = total;
    } catch (e) {
      console.warn(
        `demo-ops: skipping source ${id}: ${e instanceof Error ? e.message : "error"}`,
      );
    }
  }
  const aggregate: DemoAggregate = {
    counts,
    updatedAt: new Date().toISOString(),
  };
  try {
    const res = await fetch(
      `${base}/api/v1/artifacts/${env.DASHBOARD_ARTIFACT_ID}/data/stats/summary`,
      init(env, "PUT", JSON.stringify(aggregate)),
    );
    if (!res.ok)
      console.error(`demo-ops: dashboard write failed: ${res.status}`);
  } catch (e) {
    console.error(
      `demo-ops: dashboard write failed: ${e instanceof Error ? e.message : "error"}`,
    );
  }
}

export default {
  async scheduled(_c: unknown, env: Env, _ctx: unknown): Promise<void> {
    await tick(env);
  },
  fetch(): Response {
    return new Response("not found", { status: 404 });
  },
};
