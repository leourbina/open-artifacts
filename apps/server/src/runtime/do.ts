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
/** Fixed per-row overhead counted toward LIMITS.artifactDataBytes. */
const ROW_OVERHEAD = 64;
/** Broadcasts inline the doc only up to this many bytes; larger docs go out as data:null. */
const BROADCAST_INLINE_BYTES = 16 * 1024;
/** Hibernated sockets per DO; fetch returns 429 past it. */
const MAX_SOCKETS = 200;
/** Sockets per actor (X-OA-Actor on the upgrade request); fetch returns 429 past it. */
const MAX_SOCKETS_PER_ACTOR = 20;
/** Header carrying the subscriber's actor from the route to fetch. */
export const ACTOR_HEADER = "X-OA-Actor";
/**
 * where/orderBy queries scan and json-decode every doc in the collection, so they are
 * refused once its tracked byte total (meta "c:<collection>") exceeds this. A ~50 MB scan
 * costs hundreds of ms of CPU; 2 MiB stays near the 10 ms budget. Plain list is unaffected.
 */
const MAX_QUERY_COLLECTION_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MINUTE_MS = 60_000;
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
create table if not exists writes (
  actor text not null, minute integer not null, n integer not null,
  primary key (actor, minute)
) without rowid;
create index if not exists writes_minute on writes (minute);
create table if not exists meta (k text primary key, v integer not null) without rowid;
insert or ignore into meta (k, v) values ('bytes', 0);
`;

type SqlParam = string | number | null;

/**
 * Per-artifact live-page data (spec §6.7): shared docs, per-viewer storage, and a
 * hibernating WebSocket feed per collection. No auth here: callers (B13) authorize
 * and pass the actor ("u:{id}" | "ip:{ip}" | "agent:{id}").
 */
export class ArtifactRuntime extends DurableObject<Env> {
  private ready = false;

  /** Clock; overridable in tests. */
  now: () => number = () => Date.now();

  private get sql(): SqlStorage {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA);
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }

  /** Total stored bytes (docs + storage), as tracked in meta. */
  totalBytes(): number {
    return this.sql
      .exec<{ v: number }>("select v from meta where k = 'bytes'")
      .one().v;
  }

  /** Counts one write for `actor` this minute; throws rate_limited past the cap. */
  private countWrite(actor: string): void {
    const minute = Math.floor(this.now() / MINUTE_MS);
    const cap = actor.startsWith("ip:")
      ? LIMITS.anonWritesPerMinPerIp
      : LIMITS.viewerWritesPerMin;
    const { n } = this.sql
      .exec<{ n: number }>(
        "insert into writes (actor, minute, n) values (?, ?, 1) on conflict (actor, minute) do update set n = n + 1 returning n",
        actor,
        minute,
      )
      .one();
    if (n > cap) fail("rate_limited", "too many writes; try again in a minute");
    // Opportunistic prune: first write of a new minute for this actor.
    if (n === 1) this.sql.exec("delete from writes where minute < ?", minute);
  }

  /** Adjusts the artifact total and, for docs, the collection total (meta "c:<name>"). */
  private addBytes(delta: number, collection?: string): void {
    if (delta === 0) return;
    if (collection !== undefined)
      this.sql.exec(
        "insert into meta (k, v) values (?, ?) on conflict (k) do update set v = v + excluded.v",
        `c:${collection}`,
        delta,
      );
    const { v } = this.sql
      .exec<{ v: number }>(
        "update meta set v = v + ? where k = 'bytes' returning v",
        delta,
      )
      .one();
    if (delta > 0 && v > LIMITS.artifactDataBytes)
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
    const size =
      bytes + collection.length + id.length + actor.length + ROW_OVERHEAD;
    const updatedAt = this.iso();
    this.ctx.storage.transactionSync(() => {
      this.countWrite(actor);
      const old = this.sql
        .exec<{ size: number }>(
          "select size from docs where collection = ? and id = ?",
          collection,
          id,
        )
        .toArray()[0];
      this.addBytes(size - (old?.size ?? 0), collection);
      this.sql.exec(
        "insert into docs (collection, id, data, size, updated_at, updated_by) values (?, ?, ?, ?, ?, ?) on conflict (collection, id) do update set data = excluded.data, size = excluded.size, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
        collection,
        id,
        json,
        size,
        updatedAt,
        actor,
      );
    });
    this.broadcastDoc(
      { id, data: null, updatedAt, updatedBy: actor },
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
    return { doc: { id, data, updatedAt, updatedBy: actor }, json };
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
      const bytes =
        this.sql
          .exec<{ v: number }>("select v from meta where k = ?", `c:${c}`)
          .toArray()[0]?.v ?? 0;
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
    this.ctx.storage.transactionSync(() => {
      this.countWrite(a);
      const old = this.sql
        .exec<{ size: number }>(
          "delete from docs where collection = ? and id = ? returning size",
          c,
          i,
        )
        .toArray()[0];
      if (old) {
        existed = true;
        this.addBytes(-old.size, c);
      }
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
    this.ctx.storage.transactionSync(() => {
      this.countWrite(v);
      const old = this.sql
        .exec<{ size: number }>(
          "select size from storage where viewer = ? and key = ?",
          v,
          k,
        )
        .toArray()[0];
      this.addBytes(size - (old?.size ?? 0));
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
    this.ctx.storage.transactionSync(() => {
      this.countWrite(v);
      const old = this.sql
        .exec<{ size: number }>(
          "delete from storage where viewer = ? and key = ? returning size",
          v,
          k,
        )
        .toArray()[0];
      if (old) this.addBytes(-old.size);
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
    return new Response(null, { status: 101, webSocket: pair[0] });
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
