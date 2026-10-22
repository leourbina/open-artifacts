// An in-memory Cloudflare for the provisioner tests: the REST routes cf.ts
// calls, plus a dispatch emulation (Host -> HOSTS KV -> user Worker) that
// answers /healthz and a minimal /mcp. Nothing here talks to the network.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const API = "https://api.cloudflare.com/client/v4";

export interface LogEntry {
  method: string;
  path: string;
  status: number;
}

export interface FakeScript {
  ns: string | null;
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: upload metadata is arbitrary JSON
  metadata: any;
  modules: Map<string, { type: string; bytes: Uint8Array }>;
  secrets: Map<string, string>;
  migrationTag: string | null;
  hasAssets: boolean;
  subdomain?: { enabled: boolean; previews_enabled: boolean };
  uploads: number;
}

type Fault = {
  when: (method: string, path: string) => boolean;
  status: number;
  message: string;
  times: number;
  skip: number;
};

/** Split SQL into statements; quotes, comments and trigger bodies stay whole. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else if (c === ";") {
      const trigger = /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER/i.test(cur);
      if (trigger && !/\bEND\s*$/i.test(cur)) cur += c;
      else {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
      }
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const formEntries = (f: FormData) => {
  const out: [string, FormDataEntryValue][] = [];
  f.forEach((v, k) => {
    out.push([k, v]);
  });
  return out;
};

const env = (result: unknown, status = 200) =>
  new Response(
    JSON.stringify({ success: true, errors: [], messages: [], result }),
    { status, headers: { "content-type": "application/json" } },
  );
const fail = (status: number, message: string, code = 10000) =>
  new Response(
    JSON.stringify({
      success: false,
      errors: [{ code, message }],
      messages: [],
      result: null,
    }),
    { status, headers: { "content-type": "application/json" } },
  );

export class FakeCf {
  readonly accountId = "0123456789abcdef0123456789abcdef";
  readonly token: string;
  readonly log: LogEntry[] = [];
  /** Request bodies; NOT printable (secrets are sent to Cloudflare here). */
  readonly raw: { method: string; path: string; body: string }[] = [];
  readonly d1 = new Map<string, { name: string; db: DatabaseSync }>();
  readonly r2 = new Set<string>();
  readonly kv = new Map<
    string,
    { title: string; values: Map<string, string> }
  >();
  readonly scripts = new Map<string, FakeScript>();
  readonly namespaces = new Set(["oa-staging", "oa-prod"]);
  readonly assetHashes = new Set<string>();
  private sessions = new Map<
    string,
    { buckets: string[][]; done: number; completion: string }
  >();
  private bucketJwts = new Map<string, string>();
  private completions = new Set<string>();
  readonly artifacts = new Map<string, { title: string; content: string }>();
  private faults: Fault[] = [];
  tokenInfo: Record<string, unknown>;
  scriptsReadStatus = 200;
  /** Dispatch emulation: which KV is HOSTS and which namespace scripts live in. */
  dispatch?: { hostsKvId: string; ns: string | null };
  /** /healthz override for a script (e.g. to simulate a slow start). */
  health?: (s: FakeScript) => unknown;

  constructor(o: { token?: string; now?: number } = {}) {
    this.token = o.token ?? `cf-token-${randomBytes(12).toString("hex")}`;
    const now = o.now ?? Date.now();
    this.tokenInfo = {
      id: "tok",
      status: "active",
      not_before: new Date(now - 86_400_000).toISOString(),
      expires_on: new Date(now + 20 * 86_400_000).toISOString(),
    };
  }

  /** Fail the next `times` calls matching `when` (after skipping `skip`). */
  inject(
    when: (method: string, path: string) => boolean,
    o: {
      status?: number;
      message?: string;
      times?: number;
      skip?: number;
    } = {},
  ) {
    this.faults.push({
      when,
      status: o.status ?? 400,
      message: o.message ?? "injected failure",
      times: o.times ?? 1,
      skip: o.skip ?? 0,
    });
  }

  /** Seed a D1 (e.g. the platform DB) with SQL; returns its uuid. */
  seedD1(name: string, sql = ""): string {
    const id = randomUUID();
    const db = new DatabaseSync(":memory:");
    for (const s of splitSql(sql)) db.exec(s);
    this.d1.set(id, { name, db });
    return id;
  }
  seedKv(title: string): string {
    const id = randomBytes(16).toString("hex");
    this.kv.set(id, { title, values: new Map() });
    return id;
  }
  kvValues(id: string): Map<string, string> {
    const ns = this.kv.get(id);
    if (!ns) throw new Error(`no kv ${id}`);
    return ns.values;
  }
  script(ns: string | null, name: string): FakeScript | undefined {
    return this.scripts.get(`${ns ?? ""}/${name}`);
  }
  /** Calls that change state (non-GET, and D1 queries that are not SELECT), in order. */
  writes(): string[] {
    return this.log
      .map((e, i) => ({ e, body: this.raw[i]?.body }))
      .filter(
        ({ e, body }) =>
          e.method !== "GET" &&
          !/^[^/]+\.[a-z]+\//.test(e.path) &&
          (!e.path.includes("/query") || this.isWriteQuery(body)),
      )
      .map(({ e }) => `${e.method} ${e.path}`);
  }
  private isWriteQuery(body?: string): boolean {
    if (!body) return false;
    try {
      const sql = String(JSON.parse(body).sql ?? "");
      return !/^\s*SELECT\b/i.test(sql);
    } catch {
      return true;
    }
  }

  fetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const body = req.method === "GET" ? "" : await req.clone().text();
    const path =
      url.origin === new URL(API).origin
        ? url.pathname.replace(/^\/client\/v4/, "") + url.search
        : `${url.host}${url.pathname}`;
    const res = await this.route(req, url, body).catch((e: Error) =>
      fail(500, `fake error: ${e.message}`),
    );
    this.log.push({ method: req.method, path, status: res.status });
    this.raw.push({ method: req.method, path, body });
    return res;
  };

  private async route(req: Request, url: URL, body: string): Promise<Response> {
    if (url.origin !== new URL(API).origin) return this.serve(req, url, body);
    const p = url.pathname.replace(/^\/client\/v4/, "");
    for (const f of this.faults) {
      if (f.times > 0 && f.when(req.method, p)) {
        if (f.skip > 0) {
          f.skip--;
          continue;
        }
        f.times--;
        return fail(f.status, f.message);
      }
    }
    const a = `/accounts/${this.accountId}`;
    if (p === `/accounts/${this.accountId}/workers/assets/upload`)
      return this.assetsUpload(req, url);
    if (req.headers.get("authorization") !== `Bearer ${this.token}`)
      return fail(401, "Authentication error", 10000);
    if (p === "/user/tokens/verify") return env(this.tokenInfo);
    if (!p.startsWith(`${a}/`)) return fail(403, "wrong account");
    const r = p.slice(a.length);
    const json = () => (body ? JSON.parse(body) : {});
    let m: RegExpMatchArray | null;

    if (r === "/workers/scripts" && req.method === "GET")
      return this.scriptsReadStatus === 200
        ? env(
            [...this.scripts.values()]
              .filter((s) => s.ns === null)
              .slice(0, 1)
              .map((s) => ({ id: s.name })),
          )
        : fail(this.scriptsReadStatus, "Authentication error");
    m = r.match(/^\/workers\/scripts\/([^/]+)(\/.*)?$/);
    if (m)
      return this.scriptRoute(
        req,
        null,
        decodeURIComponent(m[1] as string),
        m[2] ?? "",
        body,
      );
    m = r.match(
      /^\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)(\/.*)?$/,
    );
    if (m) {
      const ns = decodeURIComponent(m[1] as string);
      if (!this.namespaces.has(ns)) return fail(404, "namespace not found");
      return this.scriptRoute(
        req,
        ns,
        decodeURIComponent(m[2] as string),
        m[3] ?? "",
        body,
      );
    }

    // D1
    if (r === "/d1/database" && req.method === "POST") {
      const { name } = json();
      if ([...this.d1.values()].some((d) => d.name === name))
        return fail(400, "A database with that name already exists", 7502);
      return env({ uuid: this.seedD1(name), name });
    }
    if (r === "/d1/database" && req.method === "GET") {
      const name = url.searchParams.get("name");
      return env(
        [...this.d1.entries()]
          .filter(([, d]) => name === null || d.name.includes(name))
          .map(([uuid, d]) => ({ uuid, name: d.name })),
      );
    }
    m = r.match(/^\/d1\/database\/([^/]+)\/query$/);
    if (m) {
      const d = this.d1.get(m[1] as string);
      if (!d) return fail(404, "database not found", 7404);
      const { sql, params } = json();
      try {
        return env(this.exec(d.db, sql, params ?? []));
      } catch (e) {
        return fail(400, `${(e as Error).message}: SQLITE_ERROR`, 7500);
      }
    }
    m = r.match(/^\/d1\/database\/([^/]+)$/);
    if (m) {
      const id = m[1] as string;
      if (!this.d1.has(id)) return fail(404, "database not found", 7404);
      if (req.method === "DELETE") {
        this.d1.delete(id);
        return env(null);
      }
      return env({ uuid: id, name: this.d1.get(id)?.name });
    }

    // R2
    if (r === "/r2/buckets" && req.method === "POST") {
      const { name } = json();
      if (this.r2.has(name))
        return fail(
          409,
          "The bucket you tried to create already exists",
          10004,
        );
      this.r2.add(name);
      return env({ name });
    }
    m = r.match(/^\/r2\/buckets\/([^/]+)$/);
    if (m) {
      const name = decodeURIComponent(m[1] as string);
      if (!this.r2.has(name))
        return fail(404, "The specified bucket does not exist.", 10006);
      if (req.method === "DELETE") this.r2.delete(name);
      return env({ name });
    }

    // KV
    if (r === "/storage/kv/namespaces" && req.method === "POST") {
      const { title } = json();
      if ([...this.kv.values()].some((n) => n.title === title))
        return fail(
          400,
          "a namespace with this account ID and title already exists",
          10014,
        );
      const id = this.seedKv(title);
      return env({ id, title });
    }
    if (r === "/storage/kv/namespaces" && req.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Number(url.searchParams.get("per_page") ?? 20);
      const all = [...this.kv.entries()].map(([id, n]) => ({
        id,
        title: n.title,
      }));
      return env(all.slice((page - 1) * per, page * per));
    }
    m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/);
    if (m) {
      const ns = this.kv.get(m[1] as string);
      if (!ns) return fail(404, "namespace not found", 10013);
      const key = decodeURIComponent(m[2] as string);
      if (req.method === "PUT") {
        ns.values.set(key, body);
        return env(null);
      }
      if (req.method === "DELETE") {
        ns.values.delete(key);
        return env(null);
      }
      const v = ns.values.get(key);
      return v === undefined
        ? fail(404, "key not found", 10009)
        : new Response(v, { status: 200 });
    }
    m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      if (!this.kv.delete(m[1] as string))
        return fail(404, "namespace not found", 10013);
      return env(null);
    }
    return fail(404, `fake: no route ${req.method} ${r}`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: D1 params are arbitrary JSON
  private exec(db: DatabaseSync, sql: string, params: any[]) {
    const stmts = splitSql(sql);
    return stmts.map((s) => {
      const st = db.prepare(s);
      const rows = st.all(...(stmts.length === 1 ? params : []));
      const changes = Number(
        (db.prepare("SELECT changes() AS c").get() as { c: number }).c,
      );
      return {
        results: rows,
        success: true,
        meta: { changes: /^\s*SELECT/i.test(s) ? 0 : changes },
      };
    });
  }

  private async scriptRoute(
    req: Request,
    ns: string | null,
    name: string,
    sub: string,
    body: string,
  ): Promise<Response> {
    const key = `${ns ?? ""}/${name}`;
    const s = this.scripts.get(key);
    if (sub === "" && req.method === "PUT") return this.upload(req, ns, name);
    if (sub === "" && req.method === "DELETE") {
      if (!s)
        return fail(404, "This Worker does not exist on your account.", 10007);
      this.scripts.delete(key);
      return env(null);
    }
    if (sub === "/assets-upload-session" && req.method === "POST") {
      const { manifest } = JSON.parse(body) as {
        manifest: Record<string, { hash: string; size: number }>;
      };
      for (const v of Object.values(manifest))
        if (!/^[0-9a-f]{32}$/.test(v.hash))
          return fail(
            400,
            `file hash size of ${v.hash.length} is too large`,
            10201,
          );
      const missing = [
        ...new Set(Object.values(manifest).map((v) => v.hash)),
      ].filter((h) => !this.assetHashes.has(h));
      const completion = `jwt-done-${randomBytes(8).toString("hex")}`;
      const jwt = `jwt-sess-${randomBytes(8).toString("hex")}`;
      if (missing.length === 0) {
        this.completions.add(jwt);
        return env({ jwt, buckets: [] });
      }
      const buckets = missing.map((h) => [h]);
      this.sessions.set(jwt, { buckets, done: 0, completion });
      return env({ jwt, buckets });
    }
    if (!s)
      return fail(404, "This Worker does not exist on your account.", 10007);
    if (sub === "/settings" && req.method === "GET")
      return env({ bindings: [], migration_tag: null });
    if (sub === "/secrets" && req.method === "GET")
      return env(
        [...s.secrets.keys()].map((n) => ({ name: n, type: "secret_text" })),
      );
    if (sub === "/secrets" && req.method === "PUT") {
      const { name: n, text, type } = JSON.parse(body);
      if (type !== "secret_text") return fail(400, "bad secret type");
      s.secrets.set(n, text);
      return env({ name: n, type });
    }
    if (sub === "/subdomain" && req.method === "POST") {
      if (ns !== null) return fail(405, "Method Not Allowed", 10405);
      s.subdomain = JSON.parse(body);
      return env(s.subdomain);
    }
    return fail(404, `fake: no script route ${req.method} ${sub}`);
  }

  private async upload(
    req: Request,
    ns: string | null,
    name: string,
  ): Promise<Response> {
    const form = await req.formData();
    const metaPart = form.get("metadata");
    if (typeof metaPart !== "string" && !(metaPart instanceof Blob))
      return fail(400, "missing metadata");
    const meta = JSON.parse(
      typeof metaPart === "string" ? metaPart : await metaPart.text(),
    );
    const key = `${ns ?? ""}/${name}`;
    const prev = this.scripts.get(key);
    const modules = new Map<string, { type: string; bytes: Uint8Array }>();
    for (const [k, v] of formEntries(form)) {
      if (k === "metadata") continue;
      if (!(v instanceof Blob)) return fail(400, `module ${k} is not a file`);
      modules.set(k, {
        type: v.type,
        bytes: new Uint8Array(await v.arrayBuffer()),
      });
    }
    if (!modules.has(meta.main_module)) return fail(400, "main module missing");
    // Durable Object migrations (spike-verified behaviour).
    let tag = prev?.migrationTag ?? null;
    if (meta.migrations) {
      const sent = meta.migrations.old_tag ?? "";
      if (sent !== (tag ?? ""))
        return fail(
          412,
          `Actor migration tag precondition failed, got tag '${sent}' when expected tag is '${tag ?? ""}'`,
          10079,
        );
      tag = meta.migrations.new_tag;
    }
    let hasAssets = prev?.hasAssets ?? false;
    if (meta.assets?.jwt !== undefined) {
      if (!this.completions.has(meta.assets.jwt))
        return fail(400, "invalid assets jwt");
      this.completions.delete(meta.assets.jwt);
      hasAssets = true;
    } else if (meta.keep_assets !== true || !prev?.hasAssets)
      return fail(400, "assets missing");
    const keep: string[] = meta.keep_bindings ?? [];
    const secrets =
      keep.includes("secret_text") && prev
        ? new Map(prev.secrets)
        : new Map<string, string>();
    for (const b of meta.bindings ?? [])
      if (b.type === "secret_text") secrets.set(b.name, b.text);
    this.scripts.set(key, {
      ns,
      name,
      metadata: meta,
      modules,
      secrets,
      migrationTag: tag,
      hasAssets,
      subdomain: prev?.subdomain,
      uploads: (prev?.uploads ?? 0) + 1,
    });
    return env({ id: name });
  }

  private async assetsUpload(req: Request, url: URL): Promise<Response> {
    if (url.searchParams.get("base64") !== "true")
      return fail(400, "base64=true required");
    const auth =
      req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const sessJwt = this.sessions.has(auth) ? auth : this.bucketJwts.get(auth);
    const s = sessJwt ? this.sessions.get(sessJwt) : undefined;
    if (!s || !sessJwt) return fail(401, "invalid assets session");
    const form = await req.formData();
    for (const [hash, v] of formEntries(form)) {
      if (typeof v !== "string")
        return fail(400, "parts must be base64 strings");
      const bytes = Buffer.from(v, "base64");
      const h = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
      if (h !== hash) return fail(400, "hash mismatch");
      this.assetHashes.add(hash);
    }
    s.done++;
    if (s.done < s.buckets.length) {
      const next = `jwt-b-${randomBytes(6).toString("hex")}`;
      this.bucketJwts.set(next, sessJwt);
      return env({ jwt: next }, 202);
    }
    this.completions.add(s.completion);
    return env({ jwt: s.completion }, 201);
  }

  // ----- dispatch emulation (Task 6's job in production) -----

  private findScript(host: string): FakeScript | undefined {
    if (!this.dispatch) return undefined;
    const id = this.kv.get(this.dispatch.hostsKvId)?.values.get(host);
    if (!id) return undefined;
    return [...this.scripts.values()].find(
      (s) => s.ns === this.dispatch?.ns && s.name.endsWith(id),
    );
  }

  private plain(s: FakeScript, name: string): string | undefined {
    return s.metadata.bindings.find(
      (b: { type: string; name: string }) =>
        b.type === "plain_text" && b.name === name,
    )?.text;
  }

  private async serve(req: Request, url: URL, body: string): Promise<Response> {
    const s = this.findScript(url.hostname);
    if (!s) return new Response("Not found", { status: 404 });
    if (url.pathname === "/healthz") {
      const custom = this.health?.(s);
      if (custom instanceof Response) return custom;
      const version = (s.metadata.tags as string[])
        .find((t) => /^v\d/.test(t))
        ?.slice(1);
      return Response.json(
        custom ?? { ok: true, plan: this.plain(s, "PLAN"), version },
      );
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      const auth =
        req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const dbId = s.metadata.bindings.find(
        (b: { type: string }) => b.type === "d1",
      )?.id;
      const db = this.d1.get(dbId)?.db;
      const hash = createHash("sha256").update(auth).digest("hex");
      const ok =
        db
          ?.prepare(
            "SELECT 1 FROM tokens WHERE token_hash = ? AND revoked_at IS NULL",
          )
          .get(hash) !== undefined;
      if (!ok) return new Response("unauthorized", { status: 401 });
      const msg = JSON.parse(body);
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize")
        return reply({ protocolVersion: "2025-06-18", capabilities: {} });
      if (msg.method === "tools/list")
        return reply({
          tools: [{ name: "publish_artifact" }, { name: "get_artifact" }],
        });
      if (msg.method === "tools/call") {
        const { name, arguments: args } = msg.params;
        if (name === "publish_artifact") {
          const id = `art${this.artifacts.size + 1}`;
          this.artifacts.set(id, { title: args.title, content: args.content });
          return reply({
            content: [{ type: "text", text: id }],
            structuredContent: { id, visibility: "private" },
          });
        }
        if (name === "get_artifact") {
          const a = this.artifacts.get(args.id);
          if (!a)
            return reply({
              isError: true,
              content: [{ type: "text", text: "not_found" }],
            });
          return reply({
            content: [{ type: "text", text: a.content }],
            structuredContent: {
              id: args.id,
              title: a.title,
              visibility: "private",
              content: a.content,
            },
          });
        }
      }
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "no method" },
      });
    }
    return new Response("Not found", { status: 404 });
  }
}
