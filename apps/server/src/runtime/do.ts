import { DurableObject } from "cloudflare:workers";
import {
  type DataChange,
  DataChangeSchema,
  type DataDoc,
  DataNameSchema,
  DataPatchBodySchema,
  type DataQueryInput,
  DataQuerySchema,
  ERROR_CODES,
  type ErrorCode,
  LIMITS,
  type Page,
  type StorageEntry,
  type StorageKey,
  StorageKeyNameSchema,
  StorageSetBodySchema,
} from "@oa/shared";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { indexVersionOrThrow } from "../services/search.js";
import {
  captureThumbnail,
  serverThumbnails,
  THUMB,
  type ThumbResult,
} from "../services/thumbs.js";

// Errors cross the RPC boundary as plain Error (subclass + fields are lost), so the
// code rides in the message: "oa:<code>:<message>". B13 maps it back with toRuntimeApiError.
const ERR_RE = new RegExp(`^oa:(${ERROR_CODES.join("|")}):(.*)$`, "s");

function fail(code: ErrorCode, message: string): never {
  throw new Error(`oa:${code}:${message}`);
}

/** Maps an error thrown by an ArtifactRuntime RPC call to ApiError, or null if it isn't one. */
export function toRuntimeApiError(e: unknown): ApiError | null {
  if (e instanceof ApiError) return e;
  if (!(e instanceof Error)) return null;
  const m = ERR_RE.exec(e.message);
  return m ? new ApiError(m[1] as ErrorCode, m[2] ?? "") : null;
}

/** Awaits a runtime RPC call, rethrowing runtime errors as ApiError. */
export async function runtimeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toRuntimeApiError(e) ?? e;
  }
}

const enc = new TextEncoder();
/** "u:{userId}" | "ip:{ip}" | "agent:{userId}", printable ASCII only (no NUL/surrogate collisions). */
const ACTOR_RE = /^(u|ip|agent):[\x21-\x7e]{1,250}$/;
/**
 * The updatedBy stored and returned for a write: anonymous writers are "anon"
 * (their "ip:" actor is only the internal rate-limit key, never shown to viewers).
 */
export const publicActor = (actor: string): string =>
  actor.startsWith("ip:") ? "anon" : actor;
/** Fixed per-row overhead counted toward LIMITS.artifactDataBytes. */
const ROW_OVERHEAD = 64;
/** Broadcasts inline the doc only up to this many bytes; larger docs go out as data:null. */
const BROADCAST_INLINE_BYTES = 16 * 1024;
/** Hibernated sockets per DO; fetch returns 429 past it. */
const MAX_SOCKETS = 200;
/** Sockets per actor (X-OA-Actor on the upgrade request); fetch returns 429 past it. */
const MAX_SOCKETS_PER_ACTOR = 20;
/** Max socket lifetime: a revocation the server missed can't outlive a signed URL. */
const SOCKET_TTL_MS = LIMITS.signedUrlTtlSec * 1000;
/** The alarm also closes sockets this close to their TTL, batching alarms (≤1/min). */
const SOCKET_TTL_SLACK_MS = 60_000;
/**
 * Search indexing (C3) runs this long after scheduleIndex, from the alarm:
 * a burst of publishes indexes only the newest version, and the alarm runs
 * after the publishing isolate's burst is over.
 */
export const INDEX_DELAY_MS = LIMITS.indexDebounceMs;
/** Index attempts per version before {evt:"index_failed"}. */
export const INDEX_MAX_ATTEMPTS = 5;
/** Retry delay after the n-th failure (1-based): 10 s, 20 s, 40 s, 80 s. */
export const indexBackoffMs = (n: number) => 10_000 * 2 ** (n - 1);
/**
 * Thumbnail runs per version, counted before the browser launches: a run
 * killed for CPU (uncatchable) is retried once, then the version gets none.
 */
export const THUMB_MAX_ATTEMPTS = 2;
/** When a started capture is looked at again if its run never finished. */
export const THUMB_RETRY_MS = 60_000;
/** After a launch error that is not the daily quota: the one retry, an hour on. */
export const THUMB_LAUNCH_BACKOFF_MS = 3_600_000;
/** Header carrying the subscriber's actor from the route to fetch. */
export const ACTOR_HEADER = "X-OA-Actor";
/**
 * where/orderBy queries scan and json-decode every doc in the collection, so they are
 * refused once its tracked byte total (totals.cols[collection]) exceeds this. A ~50 MB scan
 * costs hundreds of ms of CPU; 2 MiB stays near the 10 ms budget. Plain list is unaffected.
 */
const MAX_QUERY_COLLECTION_BYTES = 2 * 1024 * 1024;
/** JSON path of a collection's byte total in totals.cols. */
const colPath = (collection: string) => `$."${collection}"`;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/**
 * Data/storage writes per artifact per UTC day (DO Free: 100k rows written/day,
 * ≤3 rows per write), tracked in the single totals row.
 */
export const DAILY_WRITES = 10_000;
const MAX_CURSOR = 4096;

function dataName(v: unknown, what: string): string {
  const r = DataNameSchema.safeParse(v);
  if (!r.success) fail("bad_request", `invalid ${what}`);
  return r.data;
}

function storageKey(v: unknown): string {
  const r = StorageKeyNameSchema.safeParse(v);
  if (!r.success) fail("bad_request", "invalid key");
  return r.data;
}

function actorOf(v: unknown, what = "actor"): string {
  if (typeof v !== "string" || !ACTOR_RE.test(v))
    fail("bad_request", `invalid ${what}`);
  return v;
}

function limitOf(v: unknown): number {
  if (v === undefined) return DEFAULT_LIMIT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT)
    fail("bad_request", "invalid limit");
  return v;
}

/** JSON text of a value and its UTF-8 size, enforcing LIMITS.docBytes. */
function serialize(v: unknown): { json: string; bytes: number } {
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch {
    fail("bad_request", "value is not JSON-serializable");
  }
  if (json === undefined) fail("bad_request", "value is not JSON-serializable");
  // UTF-16 length is a lower bound on UTF-8 bytes: skip encoding obviously oversize docs.
  if (json.length > LIMITS.docBytes) fail("too_large", "document exceeds 1 MB");
  const bytes = enc.encode(json).length;
  if (bytes > LIMITS.docBytes) fail("too_large", "document exceeds 1 MB");
  return { json, bytes };
}

/** A raw request body: UTF-8 bytes (preferred: no decode in the Worker) or text. */
export type RawBody = ArrayBuffer | Uint8Array | string;

function decodeBody(body: RawBody): string {
  if (typeof body === "string") return body;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    fail("bad_request", "body is not UTF-8");
  }
}

/** DataDoc JSON with `data` spliced in from already-serialized text. */
const docJson = (head: DataDoc, json: string): string =>
  JSON.stringify({ ...head, data: null }).replace(
    '"data":null',
    () => `"data":${json}`,
  );

function encodeCursor(c: Record<string, string>): string {
  let bin = "";
  for (const b of enc.encode(JSON.stringify(c))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Strict base64url JSON object whose keys are exactly `keys`, all strings;
 * anything else is bad_request.
 */
function decodeCursor<K extends string>(
  raw: unknown,
  keys: readonly K[],
): Record<K, string> | null {
  if (raw === undefined) return null;
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_CURSOR ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  )
    fail("bad_request", "invalid cursor");
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const p: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      typeof p === "object" &&
      p !== null &&
      !Array.isArray(p) &&
      Object.keys(p).length === keys.length &&
      keys.every(
        (k) =>
          Object.hasOwn(p, k) &&
          typeof (p as Record<string, unknown>)[k] === "string",
      )
    )
      return p as Record<K, string>;
  } catch {
    // fall through
  }
  fail("bad_request", "invalid cursor");
}

type DocRow = {
  id: string;
  data: string;
  updated_at: string;
  updated_by: string | null;
};

const toDoc = (r: DocRow): DataDoc => ({
  id: r.id,
  data: JSON.parse(r.data),
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

const SCHEMA = `
create table if not exists docs (
  collection text not null, id text not null, data text not null, size integer not null,
  updated_at text not null, updated_by text, primary key (collection, id)
) without rowid;
create index if not exists docs_updated on docs (collection, updated_at, id);
create table if not exists storage (
  viewer text not null, key text not null, data text not null, size integer not null,
  updated_at text not null, primary key (viewer, key)
) without rowid;
create table if not exists totals (
  id integer primary key check (id = 1), bytes integer not null,
  day integer not null, writes integer not null, cols text not null
);
create table if not exists index_job (
  id integer primary key check (id = 1), artifact_id text not null,
  version integer not null, attempts integer not null, due integer not null,
  seq integer not null
);
create table if not exists thumb_job (
  id integer primary key check (id = 1), artifact_id text not null,
  version integer not null, attempts integer not null, due integer not null,
  state text not null
);
`;

type SqlParam = string | number | null;
/** Per-socket attachment: connect time (ms). */
type SocketMeta = { t: number };

/**
 * Per-artifact live-page data (spec §6.7): shared docs, per-viewer storage, and a
 * hibernating WebSocket feed per collection. No auth here: callers (B13) authorize
 * and pass the actor ("u:{id}" | "ip:{ip}" | "agent:{id}").
 */
export class ArtifactRuntime extends DurableObject<Env> {
  private ready = false;

  /** Clock; overridable in tests. */
  now: () => number = () => Date.now();

  /** The search indexer the alarm runs; overridable in tests. */
  indexer: (
    env: Pick<Env, "DB" | "FILES">,
    artifactId: string,
    version: number,
  ) => Promise<void> = indexVersionOrThrow;

  /** The thumbnail capture the alarm runs; overridable in tests. */
  thumbnailer: (
    env: Env,
    artifactId: string,
    version: number,
  ) => Promise<ThumbResult> = captureThumbnail;

  /**
   * Creates the schema (and migrates pre-M2 tables) outside any transaction:
   * called before every transactionSync, since a rollback there would undo the
   * DDL while `ready` stays true.
   */
  private ensureSchema(): void {
    void this.sql;
  }

  private get sql(): SqlStorage {
    if (!this.ready) {
      const sql = this.ctx.storage.sql;
      // Pre-M2 DOs: a meta (k, v) table ('bytes', 'c:<name>') and a writes table.
      const legacy =
        sql
          .exec(
            "select 1 from sqlite_master where type = 'table' and name = 'meta'",
          )
          .toArray().length > 0;
      sql.exec(SCHEMA);
      if (legacy)
        sql.exec(`insert or ignore into totals (id, bytes, day, writes, cols)
          select 1, coalesce((select v from meta where k = 'bytes'), 0), 0, 0,
            coalesce((select json_group_object(substr(k, 3), v) from meta where k like 'c:%'), '{}');
          drop table meta; drop table if exists writes;`);
      sql.exec(
        "insert or ignore into totals (id, bytes, day, writes, cols) values (1, 0, 0, 0, '{}')",
      );
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }

  /** Total stored bytes (docs + storage), as tracked in the totals row. */
  totalBytes(): number {
    return this.sql
      .exec<{ bytes: number }>("select bytes from totals where id = 1")
      .one().bytes;
  }

  /** Writes per actor in the current minute; in memory (reset on eviction), never in SQLite. */
  private rate = new Map<string, number>();
  private rateMinute = -1;

  /** Counts one write for `actor` this minute; throws rate_limited past the cap. */
  private countWrite(actor: string): void {
    const minute = Math.floor(this.now() / MINUTE_MS);
    if (minute !== this.rateMinute) {
      this.rate.clear();
      this.rateMinute = minute;
    }
    const n = (this.rate.get(actor) ?? 0) + 1;
    this.rate.set(actor, n);
    const cap = actor.startsWith("ip:")
      ? LIMITS.anonWritesPerMinPerIp
      : LIMITS.viewerWritesPerMin;
    if (n > cap) fail("rate_limited", "too many writes; try again in a minute");
  }

  /**
   * One write's bookkeeping, inside the write's transaction, as ONE row: the
   * totals row holds the artifact's bytes, today's write count (429 past
   * DAILY_WRITES) and per-collection bytes (`cols`, JSON). With the doc row and
   * its index entry that is ≤3 rows written per data write.
   */
  private bump(delta: number, collection?: string): void {
    const day = Math.floor(this.now() / DAY_MS);
    const col = collection !== undefined && delta !== 0;
    // Collection names are [A-Za-z0-9_-]: safe inside a quoted JSON path.
    const { bytes, writes } = this.sql
      .exec<{ bytes: number; writes: number }>(
        `update totals set bytes = bytes + ?,
           writes = case when day = ? then writes + 1 else 1 end, day = ?
           ${col ? ", cols = json_set(cols, ?, coalesce(json_extract(cols, ?), 0) + ?)" : ""}
         where id = 1 returning bytes, writes`,
        delta,
        day,
        day,
        ...(col ? [colPath(collection), colPath(collection), delta] : []),
      )
      .one();
    if (writes > DAILY_WRITES)
      fail("rate_limited", "daily write limit reached");
    if (delta > 0 && bytes > LIMITS.artifactDataBytes)
      fail("too_large", "artifact data exceeds 50 MB");
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Sends one pre-serialized message to every socket tagged `collection`. */
  private broadcast(collection: string, msg: string): void {
    for (const ws of this.ctx.getWebSockets(collection)) {
      try {
        ws.send(msg);
      } catch {
        // closing socket
      }
    }
  }

  /**
   * Upsert broadcast, serialized once per write. Docs over 16 KB go out with
   * `data: null`; subscribers (B13 runtime) must refetch the doc when data is null.
   */
  private broadcastDoc(doc: DataDoc, json: string, collection: string): void {
    const envelope: DataChange = DataChangeSchema.parse({
      type: "db.change",
      collection,
      docs: [{ ...doc, data: null }],
      deleted: [],
    });
    let msg = JSON.stringify(envelope);
    // Splice the already-serialized data in place of the null placeholder.
    if (
      json.length <= BROADCAST_INLINE_BYTES &&
      enc.encode(json).length <= BROADCAST_INLINE_BYTES
    )
      msg = msg.replace('"data":null', () => `"data":${json}`);
    this.broadcast(collection, msg);
  }

  private readDoc(collection: string, id: string): DocRow | null {
    return (
      this.sql
        .exec<DocRow>(
          "select id, data, updated_at, updated_by from docs where collection = ? and id = ?",
          collection,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  /** Upserts pre-serialized doc JSON; returns updatedAt. Broadcasts. */
  private writeJson(
    collection: string,
    id: string,
    json: string,
    bytes: number,
    actor: string,
  ): string {
    const by = publicActor(actor);
    const size =
      bytes + collection.length + id.length + by.length + ROW_OVERHEAD;
    const updatedAt = this.iso();
    this.countWrite(actor);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec<{ size: number }>(
          "select size from docs where collection = ? and id = ?",
          collection,
          id,
        )
        .toArray()[0];
      this.bump(size - (old?.size ?? 0), collection);
      this.sql.exec(
        "insert into docs (collection, id, data, size, updated_at, updated_by) values (?, ?, ?, ?, ?, ?) on conflict (collection, id) do update set data = excluded.data, size = excluded.size, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
        collection,
        id,
        json,
        size,
        updatedAt,
        by,
      );
    });
    this.broadcastDoc(
      { id, data: null, updatedAt, updatedBy: by },
      json,
      collection,
    );
    return updatedAt;
  }

  private writeDoc(
    collection: string,
    id: string,
    data: unknown,
    actor: string,
  ): { doc: DataDoc; json: string } {
    const { json, bytes } = serialize(data);
    const updatedAt = this.writeJson(collection, id, json, bytes, actor);
    // The caller's value (already a structured-clone copy) is returned as-is: no re-parse.
    return {
      doc: { id, data, updatedAt, updatedBy: publicActor(actor) },
      json,
    };
  }

  /**
   * Validates raw JSON text with SQLite's json_valid (one C pass; RFC 8259;
   * nesting capped at 1000) and returns it unchanged with its UTF-8 size.
   * Too deep or malformed → bad_request; over LIMITS.docBytes → too_large.
   */
  private rawJson(body: RawBody): { json: string; bytes: number } {
    const bytes =
      typeof body === "string" ? enc.encode(body).length : body.byteLength;
    if (bytes > LIMITS.docBytes) fail("too_large", "document exceeds 1 MB");
    const json = decodeBody(body);
    let ok = 0;
    try {
      ok = this.sql
        .exec<{ ok: number }>("select json_valid(?) as ok", json)
        .one().ok;
    } catch {
      ok = 0;
    }
    if (ok !== 1) fail("bad_request", "invalid JSON");
    return { json, bytes };
  }

  get(collection: string, id: string): DataDoc | null {
    const row = this.readDoc(
      dataName(collection, "collection"),
      dataName(id, "id"),
    );
    return row ? toDoc(row) : null;
  }

  /** Docs in (updated_at, id) order, keyset-paginated. */
  list(collection: string, cursor?: string, limit?: number): Page<DataDoc> {
    const c = dataName(collection, "collection");
    const n = limitOf(limit);
    const cur = decodeCursor(cursor, ["u", "i"] as const);
    const params: SqlParam[] = cur
      ? [c, cur.u, cur.u, cur.i, n + 1]
      : [c, n + 1];
    const rows = this.sql
      .exec<DocRow>(
        `select id, data, updated_at, updated_by from docs where collection = ?
         ${cur ? "and (updated_at > ? or (updated_at = ? and id > ?))" : ""}
         order by updated_at, id limit ?`,
        ...params,
      )
      .toArray();
    const items = rows.slice(0, n);
    const last = items[items.length - 1];
    return {
      items: items.map(toDoc),
      nextCursor:
        rows.length > n && last
          ? encodeCursor({ u: last.updated_at, i: last.id })
          : null,
    };
  }

  /** Typed equality filter, ordered by (orderBy value | updated_at, id), keyset-paginated. */
  query(collection: string, q: DataQueryInput): Page<DataDoc> {
    const c = dataName(collection, "collection");
    const parsed = DataQuerySchema.safeParse(q ?? {});
    if (!parsed.success) fail("bad_request", "invalid query");
    const { where, orderBy, order, limit, cursor } = parsed.data;
    // Cursor carries only the last id plus the ordering it belongs to; the sort value is
    // looked up by (collection, id), so long sort values still paginate.
    const cur = decodeCursor(cursor, ["i", "o", "d"] as const);
    if (cur && (cur.o !== (orderBy ?? "") || cur.d !== order))
      fail("bad_request", "cursor does not match query");
    if (where || orderBy) {
      const bytes = this.sql
        .exec<{ v: number }>(
          "select coalesce(json_extract(cols, ?), 0) as v from totals where id = 1",
          colPath(c),
        )
        .one().v;
      if (bytes > MAX_QUERY_COLLECTION_BYTES)
        fail("bad_request", "collection too large to query; use list");
    }

    // Keys are schema-validated identifiers, and are still only ever bound as '$.' || ? params.
    const conds: string[] = ["collection = ?"];
    const params: SqlParam[] = [c];
    for (const [k, v] of Object.entries(where ?? {})) {
      if (v === null) {
        conds.push("json_type(data, '$.' || ?) = 'null'");
        params.push(k);
      } else if (typeof v === "boolean") {
        conds.push(`json_type(data, '$.' || ?) = '${v ? "true" : "false"}'`);
        params.push(k);
      } else if (typeof v === "number") {
        conds.push(
          "json_type(data, '$.' || ?) in ('integer', 'real') and json_extract(data, '$.' || ?) = ?",
        );
        params.push(k, k, v);
      } else {
        conds.push(
          "json_type(data, '$.' || ?) = 'text' and json_extract(data, '$.' || ?) = ?",
        );
        params.push(k, k, v);
      }
    }

    // SQLite orders NULL < numbers < text, consistently for ORDER BY and comparisons.
    const sv = orderBy ? "json_extract(data, '$.' || ?)" : "updated_at";
    const svp: SqlParam[] = orderBy ? [orderBy] : [];
    const desc = order === "desc";
    if (cur) {
      const anchor = this.sql
        .exec<{ v: SqlStorageValue }>(
          `select ${sv} as v from docs where collection = ? and id = ?`,
          ...svp,
          c,
          cur.i,
        )
        .toArray()[0];
      if (!anchor) fail("bad_request", "cursor expired; restart the query");
      const v = anchor.v;
      if (v !== null && typeof v !== "number" && typeof v !== "string")
        fail("bad_request", "invalid cursor");
      const id = cur.i;
      const op = desc ? "<" : ">";
      if (v === null) {
        // NULLs come first ascending, last descending.
        if (desc) {
          conds.push(`(${sv} is null and id < ?)`);
          params.push(...svp, id);
        } else {
          conds.push(`((${sv} is null and id > ?) or ${sv} is not null)`);
          params.push(...svp, id, ...svp);
        }
      } else {
        conds.push(
          `(${sv} ${op} ? or (${sv} = ? and id ${op} ?)${desc ? ` or ${sv} is null` : ""})`,
        );
        params.push(...svp, v, ...svp, v, id, ...(desc ? svp : []));
      }
    }
    const dir = desc ? "desc" : "asc";
    const rows = this.sql
      .exec<DocRow>(
        `select id, data, updated_at, updated_by, ${sv} as sv from docs
         where ${conds.join(" and ")} order by sv ${dir}, id ${dir} limit ?`,
        ...svp,
        ...params,
        limit + 1,
      )
      .toArray();
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ i: last.id, o: orderBy ?? "", d: order })
        : null;
    return { items: items.map(toDoc), nextCursor };
  }

  set(collection: string, id: string, data: unknown, actor: string): DataDoc {
    return this.writeDoc(
      dataName(collection, "collection"),
      dataName(id, "id"),
      data,
      actorOf(actor),
    ).doc;
  }

  /**
   * set() from the raw request body (UTF-8 bytes or text): validated here,
   * never parsed in the Worker, and stored as sent. Returns updatedAt; the
   * caller already holds the rest of the DataDoc (id, body, actor).
   */
  setRaw(
    collection: string,
    id: string,
    body: RawBody,
    actor: string,
  ): { updatedAt: string } {
    const c = dataName(collection, "collection");
    const i = dataName(id, "id");
    const a = actorOf(actor);
    const { json, bytes } = this.rawJson(body);
    return { updatedAt: this.writeJson(c, i, json, bytes, a) };
  }

  /** Shallow merge into the doc (non-object docs are replaced); a missing doc is created. */
  update(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    actor: string,
  ): DataDoc {
    return this.merge(collection, id, patch, actor).doc;
  }

  /** update() from the raw request body; returns the DataDoc as JSON text. */
  updateRaw(
    collection: string,
    id: string,
    body: RawBody,
    actor: string,
  ): string {
    const { json } = this.rawJson(body);
    const { doc, json: data } = this.merge(
      collection,
      id,
      JSON.parse(json) as Record<string, unknown>,
      actor,
    );
    return docJson({ ...doc, data: null }, data);
  }

  private merge(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    actor: string,
  ): { doc: DataDoc; json: string } {
    const c = dataName(collection, "collection");
    const i = dataName(id, "id");
    const a = actorOf(actor);
    const p = DataPatchBodySchema.safeParse(patch);
    if (!p.success) fail("bad_request", "invalid patch");
    const row = this.readDoc(c, i);
    const old: unknown = row ? JSON.parse(row.data) : null;
    const base =
      old !== null && typeof old === "object" && !Array.isArray(old)
        ? (old as Record<string, unknown>)
        : {};
    return this.writeDoc(c, i, { ...base, ...p.data }, a);
  }

  delete(collection: string, id: string, actor: string): void {
    const c = dataName(collection, "collection");
    const i = dataName(id, "id");
    const a = actorOf(actor);
    let existed = false;
    this.countWrite(a);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec<{ size: number }>(
          "delete from docs where collection = ? and id = ? returning size",
          c,
          i,
        )
        .toArray()[0];
      existed = old !== undefined;
      this.bump(-(old?.size ?? 0), c);
    });
    if (existed)
      this.broadcast(
        c,
        JSON.stringify(
          DataChangeSchema.parse({
            type: "db.change",
            collection: c,
            docs: [],
            deleted: [i],
          }),
        ),
      );
  }

  storageGet(viewer: string, key: string): unknown | null {
    const v = actorOf(viewer, "viewer");
    const k = storageKey(key);
    const row = this.sql
      .exec<{ data: string }>(
        "select data from storage where viewer = ? and key = ?",
        v,
        k,
      )
      .toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }

  /** The viewer's entry with its timestamp, or null (a stored null is an entry). */
  storageEntry(viewer: string, key: string): StorageEntry | null {
    const v = actorOf(viewer, "viewer");
    const k = storageKey(key);
    const row = this.sql
      .exec<{ data: string; updated_at: string }>(
        "select data, updated_at from storage where viewer = ? and key = ?",
        v,
        k,
      )
      .toArray()[0];
    return row
      ? { key: k, value: JSON.parse(row.data), updatedAt: row.updated_at }
      : null;
  }

  /** Per-viewer value; counts against the viewer's write rate and the artifact's byte total. */
  storageSet(viewer: string, key: string, value: unknown): StorageEntry {
    return this.storageWrite(viewer, key, value).entry;
  }

  /** storageSet() from the raw StorageSetBody; returns the StorageEntry as JSON text. */
  storageSetRaw(viewer: string, key: string, body: RawBody): string {
    const { json } = this.rawJson(body);
    const r = StorageSetBodySchema.safeParse(JSON.parse(json));
    if (!r.success) fail("bad_request", "invalid body");
    const { entry, json: value } = this.storageWrite(viewer, key, r.data.value);
    return JSON.stringify({ ...entry, value: null }).replace(
      '"value":null',
      () => `"value":${value}`,
    );
  }

  private storageWrite(
    viewer: string,
    key: string,
    value: unknown,
  ): { entry: StorageEntry; json: string } {
    const v = actorOf(viewer, "viewer");
    const k = storageKey(key);
    const { json, bytes } = serialize(value);
    const size = bytes + v.length + k.length + ROW_OVERHEAD;
    const updatedAt = this.iso();
    this.countWrite(v);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec<{ size: number }>(
          "select size from storage where viewer = ? and key = ?",
          v,
          k,
        )
        .toArray()[0];
      this.bump(size - (old?.size ?? 0));
      this.sql.exec(
        "insert into storage (viewer, key, data, size, updated_at) values (?, ?, ?, ?, ?) on conflict (viewer, key) do update set data = excluded.data, size = excluded.size, updated_at = excluded.updated_at",
        v,
        k,
        json,
        size,
        updatedAt,
      );
    });
    return { entry: { key: k, value, updatedAt }, json };
  }

  storageDelete(viewer: string, key: string): void {
    const v = actorOf(viewer, "viewer");
    const k = storageKey(key);
    this.countWrite(v);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec<{ size: number }>(
          "delete from storage where viewer = ? and key = ? returning size",
          v,
          k,
        )
        .toArray()[0];
      this.bump(-(old?.size ?? 0));
    });
  }

  /** The viewer's keys in key order, keyset-paginated. */
  storageList(
    viewer: string,
    cursor?: string,
    limit?: number,
  ): Page<StorageKey> {
    const v = actorOf(viewer, "viewer");
    const n = limitOf(limit);
    const cur = decodeCursor(cursor, ["k"] as const);
    const params: SqlParam[] = cur ? [v, cur.k, n + 1] : [v, n + 1];
    const rows = this.sql
      .exec<{ key: string; updated_at: string }>(
        `select key, updated_at from storage where viewer = ? ${cur ? "and key > ?" : ""} order by key limit ?`,
        ...params,
      )
      .toArray();
    const items = rows.slice(0, n);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => ({ key: r.key, updatedAt: r.updated_at })),
      nextCursor:
        rows.length > n && last ? encodeCursor({ k: last.key }) : null,
    };
  }

  /** WebSocket subscribe: Upgrade + `?collection=<DataName>`, tagged for hibernation. */
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });
    const r = DataNameSchema.safeParse(
      new URL(req.url).searchParams.get("collection"),
    );
    if (!r.success) return new Response("Invalid collection", { status: 400 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS)
      return new Response("Too many subscribers", { status: 429 });
    // Optional per-actor cap (the route passes the authorized actor).
    const tags = [r.data];
    const actor = req.headers.get(ACTOR_HEADER);
    if (actor !== null) {
      if (!ACTOR_RE.test(actor))
        return new Response("Invalid actor", { status: 400 });
      const tag = `a:${actor}`;
      if (this.ctx.getWebSockets(tag).length >= MAX_SOCKETS_PER_ACTOR)
        return new Response("Too many subscriptions", { status: 429 });
      tags.push(tag);
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], tags);
    const t = this.now();
    pair[1].serializeAttachment({ t } satisfies SocketMeta);
    await this.armAt(t + SOCKET_TTL_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Moves the one alarm earlier to `t` (never later): it serves every kind of work. */
  private async armAt(t: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > t) await this.ctx.storage.setAlarm(t);
  }

  /**
   * Queues search indexing of `version` (C3): one pending job per artifact.
   * A newer version replaces the job (attempts reset, due INDEX_DELAY_MS from
   * now); the same version only bumps `seq` (keeping any retry backoff), so a
   * re-enqueue while the alarm runs it is never dropped; an older one is
   * ignored. With `thumb` (publish, restore) and serverThumbnails(env), the same
   * debounce queues a server-side thumbnail of the newest version.
   */
  async scheduleIndex(
    artifactId: string,
    version: number,
    thumb = false,
  ): Promise<void> {
    if (typeof artifactId !== "string" || artifactId.length > 64)
      fail("bad_request", "invalid artifact id");
    if (!Number.isSafeInteger(version) || version < 1)
      fail("bad_request", "invalid version");
    const due = this.now() + INDEX_DELAY_MS;
    this.sql.exec(
      `insert into index_job (id, artifact_id, version, attempts, due, seq) values (1, ?, ?, 0, ?, 1)
       on conflict (id) do update set
         seq = index_job.seq + 1,
         attempts = case when excluded.version > index_job.version then 0 else index_job.attempts end,
         due = case when excluded.version > index_job.version then excluded.due else index_job.due end,
         artifact_id = excluded.artifact_id, version = excluded.version
       where excluded.version >= index_job.version`,
      artifactId,
      version,
      due,
    );
    if (thumb && serverThumbnails(this.env))
      this.sql.exec(
        `insert into thumb_job (id, artifact_id, version, attempts, due, state)
         values (1, ?, ?, 0, ?, 'pending')
         on conflict (id) do update set artifact_id = excluded.artifact_id,
           version = excluded.version, attempts = 0, due = excluded.due,
           state = 'pending'
         where excluded.version > thumb_job.version`,
        artifactId,
        version,
        due,
      );
    await this.armAt(due);
  }

  /** The pending index job, if any (tests and the alarm). */
  pendingIndex(): {
    artifactId: string;
    version: number;
    attempts: number;
    due: number;
    seq: number;
  } | null {
    const r = this.sql
      .exec<{
        artifact_id: string;
        version: number;
        attempts: number;
        due: number;
        seq: number;
      }>(
        "select artifact_id, version, attempts, due, seq from index_job where id = 1",
      )
      .toArray()[0];
    return r
      ? {
          artifactId: r.artifact_id,
          version: r.version,
          attempts: r.attempts,
          due: r.due,
          seq: r.seq,
        }
      : null;
  }

  /** The latest version's thumbnail job and its state (tests). */
  thumbnailJob(): {
    artifactId: string;
    version: number;
    attempts: number;
    due: number;
    state: "pending" | "done" | "no_thumb";
  } | null {
    const r = this.sql
      .exec<{
        artifact_id: string;
        version: number;
        attempts: number;
        due: number;
        state: "pending" | "done" | "no_thumb";
      }>(
        "select artifact_id, version, attempts, due, state from thumb_job where id = 1",
      )
      .toArray()[0];
    return r
      ? {
          artifactId: r.artifact_id,
          version: r.version,
          attempts: r.attempts,
          due: r.due,
          state: r.state,
        }
      : null;
  }

  /** The pending thumbnail job, if any (tests and the alarm). */
  pendingThumbnail(): {
    artifactId: string;
    version: number;
    attempts: number;
    due: number;
  } | null {
    const j = this.thumbnailJob();
    return j?.state === "pending"
      ? {
          artifactId: j.artifactId,
          version: j.version,
          attempts: j.attempts,
          due: j.due,
        }
      : null;
  }

  /**
   * One alarm, multiplexed by the next due time of both kinds of work:
   * - Socket lifetime: closes sockets older than LIMITS.signedUrlTtlSec (minus
   *   a 60 s batching slack) with 4408 "reconnect"; the client reconnects
   *   through the shell, which re-checks access.
   * - Search indexing: runs the pending job (one version per alarm): a first
   *   attempt whenever the alarm fires (INDEX_DELAY_MS is a best-effort
   *   debounce), a retry only once its backoff is due.
   *   A failure retries with indexBackoffMs, up to INDEX_MAX_ATTEMPTS, then
   *   logs {evt:"index_failed"} and drops the job. A job re-enqueued while
   *   it ran (seq changed) stays pending.
   * - Thumbnails: never in the same run as indexing (its browser wait would
   *   skew the index alarm): a run that indexed re-arms at once when a
   *   capture is pending (runThumbnail).
   * Re-arms for the oldest remaining socket or the pending job.
   */
  override async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const job = this.pendingIndex();
    const thumb = this.pendingThumbnail();
    if (!job && !thumb && sockets.length === 0) return;
    const now = this.now();
    let next = Number.POSITIVE_INFINITY;
    for (const ws of sockets) {
      const t = (ws.deserializeAttachment() as SocketMeta | null)?.t ?? 0;
      if (now - t >= SOCKET_TTL_MS - SOCKET_TTL_SLACK_MS) {
        try {
          ws.close(4408, "reconnect");
        } catch {
          // already closed
        }
      } else next = Math.min(next, t + SOCKET_TTL_MS);
    }
    const indexDue = !!job && (job.attempts === 0 || job.due <= now);
    if (job && indexDue) {
      const same = "where id = 1 and seq = ?";
      const key = [job.seq] as const;
      try {
        await this.indexer(this.env, job.artifactId, job.version);
        this.sql.exec(`delete from index_job ${same}`, ...key);
      } catch (e) {
        const attempts = job.attempts + 1;
        if (attempts >= INDEX_MAX_ATTEMPTS) {
          console.error(
            JSON.stringify({
              evt: "index_failed",
              artifactId: job.artifactId,
              version: job.version,
              attempts,
              error: String((e as Error)?.message ?? e).slice(0, 300),
            }),
          );
          this.sql.exec(`delete from index_job ${same}`, ...key);
        } else
          this.sql.exec(
            `update index_job set attempts = ?, due = ? ${same}`,
            attempts,
            this.now() + indexBackoffMs(attempts),
            ...key,
          );
      }
    }
    if (!indexDue && thumb && (thumb.attempts === 0 || thumb.due <= now))
      await this.runThumbnail(thumb);
    const pending = this.pendingIndex();
    if (pending) next = Math.min(next, pending.due);
    const pendingThumb = this.pendingThumbnail();
    if (pendingThumb)
      next = Math.min(
        next,
        indexDue && pendingThumb.attempts === 0 ? this.now() : pendingThumb.due,
      );
    if (next !== Number.POSITIVE_INFINITY)
      await this.ctx.storage.setAlarm(next);
  }

  /**
   * At most one capture (one browser session) per alarm run, strictly
   * best-effort (the client upload is the fallback). The attempt is counted
   * and an alarm armed BEFORE the browser launches, so a run killed for CPU
   * (which nothing can catch) is looked at again THUMB_RETRY_MS later and
   * retried once; at THUMB_MAX_ATTEMPTS the version gets no server thumbnail.
   * A deferral (launch slot taken) or a launch error that is not the daily
   * quota (after THUMB_LAUNCH_BACKOFF_MS) is retried within the same budget;
   * any other outcome, failures included, ends the job. A newer version queued
   * meanwhile replaces the job (writes below match on version).
   */
  private async runThumbnail(job: {
    artifactId: string;
    version: number;
    attempts: number;
  }): Promise<void> {
    const same = "where id = 1 and version = ?";
    const end = (state: "done" | "no_thumb") =>
      this.sql.exec(
        `update thumb_job set state = ? ${same}`,
        state,
        job.version,
      );
    // Queued before the gate turned off: drop it, no attempt written.
    if (!serverThumbnails(this.env)) {
      end("no_thumb");
      return;
    }
    if (job.attempts >= THUMB_MAX_ATTEMPTS) {
      console.error(
        JSON.stringify({
          evt: "thumbnail_abandoned",
          artifactId: job.artifactId,
          version: job.version,
          attempts: job.attempts,
        }),
      );
      end("no_thumb");
      return;
    }
    const retryAt = this.now() + THUMB_RETRY_MS;
    this.sql.exec(
      `update thumb_job set attempts = attempts + 1, due = ? ${same}`,
      retryAt,
      job.version,
    );
    await this.ctx.storage.setAlarm(retryAt);
    await this.ctx.storage.sync();
    let result: ThumbResult;
    try {
      result = await this.thumbnailer(this.env, job.artifactId, job.version);
    } catch (e) {
      console.error(
        JSON.stringify({
          evt: "thumbnail_failed",
          artifactId: job.artifactId,
          version: job.version,
          error: String((e as Error)?.message ?? e).slice(0, 300),
        }),
      );
      result = "failed";
    }
    const retryIn =
      result === "deferred"
        ? THUMB.launchGapMs
        : result === "launch_failed"
          ? THUMB_LAUNCH_BACKOFF_MS
          : null;
    if (retryIn !== null && job.attempts + 1 < THUMB_MAX_ATTEMPTS)
      this.sql.exec(
        `update thumb_job set due = ? ${same}`,
        this.now() + retryIn,
        job.version,
      );
    else end(result === "stored" || result === "skipped" ? "done" : "no_thumb");
  }

  /** Subscribe-only feed: any client message closes the socket (1008 policy violation). */
  override webSocketMessage(ws: WebSocket): void {
    try {
      ws.close(1008, "subscribe-only");
    } catch {
      // already closed
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
  }

  /**
   * Closes every subscriber socket with 4403 (access may have changed: share
   * revoked, visibility changed, artifact deleted). Clients reconnect through
   * the shell, which re-checks access.
   */
  closeSockets(reason: string): number {
    const all = this.ctx.getWebSockets();
    for (const ws of all) {
      try {
        ws.close(4403, reason.slice(0, 120));
      } catch {
        // already closed
      }
    }
    return all.length;
  }

  /** Wipes all data (called by purge). The schema is recreated lazily on next use. */
  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1001, "artifact deleted");
      } catch {
        // already closed
      }
    }
    this.ready = false;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }
}

type RpcMethods =
  | "get"
  | "list"
  | "query"
  | "set"
  | "update"
  | "delete"
  | "storageGet"
  | "storageEntry"
  | "storageSet"
  | "setRaw"
  | "updateRaw"
  | "storageSetRaw"
  | "closeSockets"
  | "scheduleIndex"
  | "pendingIndex"
  | "storageDelete"
  | "storageList"
  | "destroy";

/**
 * Typed RPC view of the DO. workers-types maps `unknown` (DataDoc.data) to `never`
 * through Rpc.Result, so callers use this instead of the raw stub type.
 */
export type RuntimeStub = {
  [K in RpcMethods]: (
    ...args: Parameters<ArtifactRuntime[K]>
  ) => Promise<Awaited<ReturnType<ArtifactRuntime[K]>>>;
} & { fetch(req: Request | string, init?: RequestInit): Promise<Response> };

/** The artifact's runtime DO (one per artifact id). Wrap calls in runtimeCall for ApiError. */
export function runtimeStub(
  env: Pick<Env, "ARTIFACT_RUNTIME">,
  artifactId: string,
): RuntimeStub {
  const ns = env.ARTIFACT_RUNTIME;
  return ns.get(ns.idFromName(artifactId)) as unknown as RuntimeStub;
}
