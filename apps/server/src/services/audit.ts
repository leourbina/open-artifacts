import {
  type AuditAction,
  AuditActionSchema,
  type AuditEvent,
  type AuditReason,
  AuditReasonSchema,
  isId,
  newId,
  type Page,
} from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";

// The audit log (P3 T8). audit() is a statement, never a write: callers put it
// in the same D1 batch as the change it records, so both commit or neither
// does. Rows hold ids and enums only; the actor's email is joined at read
// time, never stored, and no code, token or other address is ever written.

/** Who did it: a signed-in user, directory sync, or the system (cron, alarms). */
export type AuditActor = {
  kind: "user" | "sync" | "system";
  id: string | null;
};

export type AuditExtra = {
  spaceId?: string | null;
  reason?: AuditReason;
  /** Enums and ids only. `reason` is reserved (stored alongside, read back as AuditEvent.reason). */
  detail?: Record<string, unknown>;
  /**
   * Inserts the row only when this SQL condition holds after the change ran
   * (e.g. the share row exists, or `changes() > 0` right after the change),
   * so a no-op or lost race writes no audit row.
   */
  when?: { sql: string; args: unknown[] };
};

const INSERT = `insert into audit_events
  (id, at, actor_kind, actor_id, action, target_type, target_id, space_id, detail)
  select ?, ?, ?, ?, ?, ?, ?, ?, ?`;

/** One audit row, as a statement for the caller's own batch. */
export function audit(
  env: Env,
  action: AuditAction,
  target: AuditEvent["target"],
  actor: AuditActor,
  extra: AuditExtra = {},
): D1PreparedStatement {
  const detail = {
    ...extra.detail,
    ...(extra.reason && { reason: extra.reason }),
  };
  const sql = extra.when ? `${INSERT} where ${extra.when.sql}` : INSERT;
  return stmt(env.DB, sql).bind(
    newId(),
    Date.now(),
    actor.kind,
    actor.id,
    action,
    target.type,
    target.id,
    extra.spaceId ?? null,
    JSON.stringify(detail),
    ...(extra.when?.args ?? []),
  );
}

/** A user acting on their own behalf. */
export const userActor = (id: string): AuditActor => ({ kind: "user", id });

/**
 * auth.signin for P2's admission seam: the provider and, when verified, the
 * tenant domain. Never the address.
 */
export const signInAudit = (
  env: Env,
  userId: string,
  provider: string,
  tenant?: string | null,
): D1PreparedStatement =>
  audit(env, "auth.signin", { type: "user", id: userId }, userActor(userId), {
    detail: { provider, ...(tenant ? { tenant } : {}) },
  });

// ------------------------------------------------------------------- read

type Row = {
  id: string;
  at: number;
  actorKind: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  spaceId: string | null;
  detail: string;
};

const ACTOR_KINDS = new Set(["user", "sync", "system"]);
const ACTIONS: ReadonlySet<string> = new Set(AuditActionSchema.options);
const TARGETS = new Set([
  "space",
  "artifact",
  "user",
  "mapping",
  "group",
  "directory",
]);

/**
 * Newest first, keyset on (at, id) (audit_events_at_idx; WITHOUT ROWID, so
 * the index carries id). Only contract rows: P2's test-hook rows
 * (actor_kind 'test_hook') are not AuditEvents and stay out.
 */
const PAGE_SQL = (
  after: boolean,
) => `select e.id, e.at, e.actor_kind as actorKind,
    e.actor_id as actorId, u.email as actorEmail, e.action,
    e.target_type as targetType, e.target_id as targetId,
    e.space_id as spaceId, e.detail
  from audit_events e left join users u on u.id = e.actor_id
  where e.actor_kind in ('user', 'sync', 'system')${
    after ? " and (e.at < ?2 or (e.at = ?2 and e.id < ?3))" : ""
  }
  order by e.at desc, e.id desc limit ?1`;

function parseDetail(s: string): {
  reason: AuditReason | null;
  detail: Record<string, unknown> | null;
} {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return { reason: null, detail: null };
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { reason: null, detail: null };
  const { reason, ...rest } = v as Record<string, unknown>;
  const r = AuditReasonSchema.safeParse(reason);
  return {
    reason: r.success ? r.data : null,
    detail: Object.keys(rest).length ? rest : null,
  };
}

function toEvent(r: Row): AuditEvent | null {
  if (
    !ACTOR_KINDS.has(r.actorKind) ||
    !ACTIONS.has(r.action) ||
    !TARGETS.has(r.targetType) ||
    r.targetId === null
  )
    return null;
  return {
    id: r.id,
    at: new Date(r.at).toISOString(),
    actor: {
      kind: r.actorKind as AuditEvent["actor"]["kind"],
      id: r.actorId,
      email: r.actorKind === "user" ? r.actorEmail : null,
    },
    action: r.action as AuditAction,
    target: {
      type: r.targetType as AuditEvent["target"]["type"],
      id: r.targetId,
    },
    spaceId: r.spaceId,
    ...parseDetail(r.detail),
  };
}

type Cursor = { a: number; i: string };
const B64URL = /^[A-Za-z0-9_-]+$/;

const encodeCursor = (c: Cursor): string =>
  btoa(JSON.stringify(c))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Strict: anything but b64url JSON `{a: int, i: id}` is 400. */
function decodeCursor(s: string): Cursor {
  const invalid = () =>
    new ApiError("bad_request", "Invalid cursor", {
      path: "cursor",
      reason: "invalid",
    });
  if (!B64URL.test(s) || s.length > 200) throw invalid();
  let v: unknown;
  try {
    v = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw invalid();
  }
  const c = v as Cursor;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== 2 ||
    !Number.isSafeInteger(c.a) ||
    typeof c.i !== "string" ||
    !isId(c.i)
  )
    throw invalid();
  return { a: c.a, i: c.i };
}

export const AUDIT_PAGE_MAX = 100;

/** One page of the audit log, newest first. Callers check audit.read. */
export async function listAudit(
  env: Env,
  cursor: string | undefined,
  limit: number,
): Promise<Page<AuditEvent>> {
  const after = cursor ? decodeCursor(cursor) : null;
  const q = stmt(env.DB, PAGE_SQL(after !== null));
  const { results } = await (after
    ? q.bind(limit + 1, after.a, after.i)
    : q.bind(limit + 1)
  ).all<Row>();
  const more = results.length > limit;
  const rows = more ? results.slice(0, limit) : results;
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toEvent).filter((e): e is AuditEvent => e !== null),
    nextCursor: more && last ? encodeCursor({ a: last.at, i: last.id }) : null,
  };
}

const EXPORT_CHUNK = 500;

/**
 * Every event as NDJSON, newest first, read one keyset page per pull so the
 * whole log is never in memory.
 */
export function exportAudit(env: Env): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let after: Cursor | null = null;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      const q = stmt(env.DB, PAGE_SQL(after !== null));
      const { results } = await (after
        ? q.bind(EXPORT_CHUNK, after.a, after.i)
        : q.bind(EXPORT_CHUNK)
      ).all<Row>();
      const last = results[results.length - 1];
      let out = "";
      for (const r of results) {
        const e = toEvent(r);
        if (e) out += `${JSON.stringify(e)}\n`;
      }
      if (out) controller.enqueue(enc.encode(out));
      if (results.length < EXPORT_CHUNK || !last) {
        done = true;
        controller.close();
        return;
      }
      after = { a: last.at, i: last.id };
    },
  });
}
