import {
  type Capabilities,
  CapabilitiesSchema,
  DataNameSchema,
  DataQuerySchema,
  isId,
  LIMITS,
  METHOD_CAPABILITY,
  RUNTIME_PARAMS,
  type RuntimeMethod,
  StorageKeyNameSchema,
} from "@oa/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { caller, requireAccess } from "../auth/authz.js";
import { cappedJson, readCapped } from "../http/body.js";
import { ApiError, appOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import type { AppType } from "../routes/index.js";
import { ACTOR_HEADER, runtimeCall, runtimeStub } from "./do.js";

// Literals so Hono infers params; must equal R.data* / R.storage* in @oa/shared.
const ART = "/api/v1/artifacts/:id";
const COL = `${ART}/data/:col`;
const QUERY = `${COL}/query`;
const DOC = `${COL}/:doc`;
const SUBSCRIBE = `${ART}/data-subscribe`;
const STORAGE = `${ART}/storage`;
const KEY = `${STORAGE}/:key`;

/** Raw write bodies (doc, patch, {value}): ≤ LIMITS.docBytes once minified; allow whitespace slack. */
const MAX_DOC_BODY = LIMITS.docBytes + 64 * 1024;
const MAX_QUERY_BODY = 64 * 1024;
/** CF-Connecting-IP: IPv4 or IPv6 text form. */
const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

type C = Context<AppEnv>;
type Gate = { artifactId: string; actor: string };

const NO_CAPS: Capabilities = { db: false, viewer: false, storage: false };
function capsOf(json: string): Capabilities {
  try {
    const r = CapabilitiesSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : NO_CAPS;
  } catch {
    return NO_CAPS;
  }
}

function name(v: string | undefined, what: string): string {
  const r = DataNameSchema.safeParse(v);
  if (!r.success) throw new ApiError("bad_request", `Invalid ${what}`);
  return r.data;
}

/**
 * Rate-limit identity for an anonymous IP: IPv4 as is; IPv6 as its /64
 * ("2001:db8:1:2::/64"), since one host can rotate through a whole /64.
 * Null when `ip` is not an address.
 */
export function ipKey(ip: string): string | null {
  if (IPV4_RE.test(ip))
    return ip.split(".").every((o) => Number(o) <= 255) ? ip : null;
  if (!IP_RE.test(ip) || !ip.includes(":")) return null;
  let s = ip.toLowerCase();
  // Embedded IPv4 tail (::ffff:1.2.3.4) → two hex groups.
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = (v4[2] as string).split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = o;
    s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * Applies RL_ANON to `key`. Fails closed (503) when the binding is missing
 * outside ENVIRONMENT=dev (the test pool and local dev have none).
 */
async function anonLimit(c: C, key: string, what: string): Promise<void> {
  const rl = c.env.RL_ANON;
  if (!rl) {
    if (c.env.ENVIRONMENT === "dev") return;
    throw new HTTPException(503, { message: "rate limiter unavailable" });
  }
  if (!(await rl.limit({ key })).success)
    throw new ApiError(
      "rate_limited",
      `Too many ${what}; try again in a minute`,
    );
}

/**
 * Access (404 for no access, never 403), then the declared capability
 * (403 capability_denied: access is already proven), then the caller's actor:
 * - storage: signed-in only (401), actor "u:{id}" (the storage owner).
 * - data writes: signed-in "u:{id}"; anonymous only with allowAnonymousWrites
 *   (else 401), after RL_ANON "ip:{key}" (429; 503 if unbound outside dev),
 *   as "ip:{key}" (ipKey: IPv4, or the IPv6 /64).
 * - subscribe: signed-in "u:{id}"; anonymous "ip:{key}" after RL_ANON "sub:ip:{key}".
 * - data reads: anyone with view access (actor unused).
 */
async function gate(
  c: C,
  method: RuntimeMethod,
  kind: "read" | "write" | "storage" | "subscribe",
): Promise<Gate> {
  const artifactId = c.req.param("id") ?? "";
  if (!isId(artifactId)) throw new ApiError("not_found", "Not found");
  const who = caller(c);
  const a = await requireAccess(c.env, who, artifactId, "viewer");
  const cap = METHOD_CAPABILITY[method];
  if (!capsOf(a.capabilities)[cap])
    throw new ApiError(
      "capability_denied",
      `This artifact did not declare the "${cap}" capability`,
    );
  if (who.kind === "user") return { artifactId, actor: `u:${who.user.id}` };
  if (kind === "read") return { artifactId, actor: "" };
  if (kind === "storage" || (kind === "write" && a.allowAnonymousWrites !== 1))
    throw new ApiError("unauthorized", "Sign in to save changes");
  const key = ipKey(c.req.header("cf-connecting-ip") ?? "");
  if (!key)
    throw new ApiError("rate_limited", "Anonymous access is unavailable");
  if (kind === "subscribe")
    await anonLimit(c, `sub:ip:${key}`, "subscriptions");
  else await anonLimit(c, `ip:${key}`, "writes");
  return { artifactId, actor: `ip:${key}` };
}

const enc = new TextEncoder();
const toBuffer = (b: Uint8Array): ArrayBuffer =>
  b.byteOffset === 0 && b.buffer.byteLength === b.byteLength
    ? (b.buffer as ArrayBuffer)
    : (b.slice().buffer as ArrayBuffer);
/** The raw request body, capped while streaming; never decoded or parsed here. */
const rawBody = async (c: C): Promise<ArrayBuffer> =>
  toBuffer(await readCapped(c, MAX_DOC_BODY));
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
const jsonText = (text: string) =>
  new Response(text, {
    headers: { "content-type": "application/json; charset=UTF-8" },
  });

const stub = (c: C, g: Gate) => runtimeStub(c.env, g.artifactId);

export function mountRuntime(app: AppType): void {
  app.get(COL, async (c) => {
    const g = await gate(c, "db.list", "read");
    const p = RUNTIME_PARAMS["db.list"].safeParse({
      collection: c.req.param("col"),
      cursor: c.req.query("cursor"),
      limit: intParam(c.req.query("limit")),
    });
    if (!p.success) throw new ApiError("bad_request", "Invalid list request");
    const { collection, cursor, limit: n } = p.data;
    return c.json(
      await runtimeCall(() => stub(c, g).list(collection, cursor, n)),
    );
  });

  // A read, but POST: the query is a JSON body.
  app.post(QUERY, async (c) => {
    const g = await gate(c, "db.query", "read");
    const col = name(c.req.param("col"), "collection");
    const q = await cappedJson(c, DataQuerySchema, MAX_QUERY_BODY);
    return c.json(await runtimeCall(() => stub(c, g).query(col, q)));
  });

  app.get(DOC, async (c) => {
    const g = await gate(c, "db.get", "read");
    const col = name(c.req.param("col"), "collection");
    const id = name(c.req.param("doc"), "document id");
    const d = await runtimeCall(() => stub(c, g).get(col, id));
    if (!d) throw new ApiError("not_found", "Not found");
    return c.json(d);
  });

  app.put(DOC, async (c) => {
    const g = await gate(c, "db.set", "write");
    const col = name(c.req.param("col"), "collection");
    const id = name(c.req.param("doc"), "document id");
    const body = await readCapped(c, MAX_DOC_BODY);
    const { updatedAt } = await runtimeCall(() =>
      stub(c, g).setRaw(col, id, toBuffer(body), g.actor),
    );
    // The DataDoc, with the (DO-validated) body bytes spliced in unparsed.
    const [head, tail] = JSON.stringify({
      id,
      data: null,
      updatedAt,
      updatedBy: g.actor,
    }).split('"data":null');
    return new Response(
      concat(enc.encode(`${head}"data":`), body, enc.encode(tail ?? "")),
      { headers: { "content-type": "application/json; charset=UTF-8" } },
    );
  });

  app.patch(DOC, async (c) => {
    const g = await gate(c, "db.update", "write");
    const col = name(c.req.param("col"), "collection");
    const id = name(c.req.param("doc"), "document id");
    const body = await rawBody(c);
    return jsonText(
      await runtimeCall(() => stub(c, g).updateRaw(col, id, body, g.actor)),
    );
  });

  app.delete(DOC, async (c) => {
    const g = await gate(c, "db.delete", "write");
    const col = name(c.req.param("col"), "collection");
    const id = name(c.req.param("doc"), "document id");
    await runtimeCall(() => stub(c, g).delete(col, id, g.actor));
    return c.body(null, 204);
  });

  // WebSocket feed of DataChange frames, served by the artifact's DO.
  app.get(SUBSCRIBE, async (c) => {
    // Browsers always send Origin on WebSocket handshakes: refuse other sites.
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== appOrigin(c.env))
      throw new ApiError("csrf", "Cross-site request");
    const g = await gate(c, "db.subscribe", "subscribe");
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return c.text("Expected WebSocket upgrade", 426);
    const col = name(c.req.query("collection"), "collection");
    const url = `https://runtime.invalid/subscribe?collection=${encodeURIComponent(col)}`;
    return stub(c, g).fetch(url, {
      headers: { Upgrade: "websocket", [ACTOR_HEADER]: g.actor },
    });
  });

  app.get(STORAGE, async (c) => {
    const g = await gate(c, "storage.list", "storage");
    const p = RUNTIME_PARAMS["storage.list"].safeParse({
      cursor: c.req.query("cursor"),
      limit: intParam(c.req.query("limit")),
    });
    if (!p.success) throw new ApiError("bad_request", "Invalid list request");
    const { cursor, limit: n } = p.data;
    return c.json(
      await runtimeCall(() => stub(c, g).storageList(g.actor, cursor, n)),
    );
  });

  app.get(KEY, async (c) => {
    const g = await gate(c, "storage.get", "storage");
    const key = storageKeyOf(c);
    const e = await runtimeCall(() => stub(c, g).storageEntry(g.actor, key));
    if (!e) throw new ApiError("not_found", "Not found");
    return c.json(e);
  });

  app.put(KEY, async (c) => {
    const g = await gate(c, "storage.set", "storage");
    const key = storageKeyOf(c);
    const body = await rawBody(c);
    return jsonText(
      await runtimeCall(() => stub(c, g).storageSetRaw(g.actor, key, body)),
    );
  });

  app.delete(KEY, async (c) => {
    const g = await gate(c, "storage.delete", "storage");
    const key = storageKeyOf(c);
    await runtimeCall(() => stub(c, g).storageDelete(g.actor, key));
    return c.body(null, 204);
  });
}

/** Query-string integer: undefined when absent, NaN (fails the schema) when malformed. */
const intParam = (v: string | undefined): number | undefined =>
  v === undefined ? undefined : /^\d{1,4}$/.test(v) ? Number(v) : Number.NaN;

function storageKeyOf(c: C): string {
  const r = StorageKeyNameSchema.safeParse(c.req.param("key"));
  if (!r.success) throw new ApiError("bad_request", "Invalid key");
  return r.data;
}
