import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { core, envelope, ROOT, STATE } from "./fakes.ts";

const TEMPLATE = "apps/server/wrangler.template.jsonc";
const WELCOME = "scripts/setup/welcome.md";
const realRoot = join(import.meta.dirname, "../../..");

// Recorded shape of `wrangler whoami --json`.
export const WHOAMI = (ids: string[]) =>
  JSON.stringify({
    loggedIn: true,
    authType: "OAuth Token",
    email: "owner@example.com",
    accounts: ids.map((id) => ({ id, name: `Account ${id}` })),
  });
// Staging's real resources (apps/server/wrangler.staging.jsonc).
export const STAGING = {
  d1: [
    {
      uuid: "5155e2d4-d9bf-4900-b4ab-1febd480377a",
      name: "open-artifacts-staging",
    },
  ],
  r2: [{ name: "open-artifacts-staging" }],
  kv: [
    {
      id: "886a49c875024e8ab5262928d75f85b7",
      title: "open-artifacts-staging-oauth",
    },
  ],
};
/** Unrelated namespaces that push real ones past the first KV page. */
export const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `f${i}`, title: `other-${i}` }));

type World = {
  accounts?: string[];
  zones?: string[];
  d1?: { uuid: string; name: string }[];
  r2?: { name: string }[];
  kv?: { id: string; title: string }[];
  answers?: string[];
  /** Access organization: 403s for the wrangler token, or none at all. */
  org?: "forbidden" | "none" | "404";
  policies?: Obj[];
  apps?: Obj[];
  /** Worker secret names; undefined means the Worker does not exist yet. */
  secrets?: string[];
  putFails?: string;
  deleteFails?: boolean;
  /** Preloaded .openartifacts/state.json. */
  state?: Obj;
  /** Omit result_info from list pages (paging must stop on a short page). */
  noResultInfo?: boolean;
  /** /healthz answers 503 this many times first (propagation). */
  healthFails?: number;
  /** tools/list omits publish_artifact. */
  noPublishTool?: boolean;
  /** The token INSERT fails, or silently writes nothing. */
  d1Fails?: boolean;
  dropTokenInsert?: boolean;
  /** The signed content URL serves this body instead of the published content. */
  contentBody?: string;
  /** The signed content URL answers with this status. */
  contentStatus?: number;
  /** Artifact ids that no longer exist (publish with that id → not_found). */
  deletedArtifacts?: string[];
  /** Every publish fails with this tool error text. */
  publishError?: string;
  /** The publish result's view url, overriding the default. */
  viewUrl?: string;
};
// biome-ignore lint/suspicious/noExplicitAny: loose API fixtures
type Obj = any;

export const POLICY = {
  id: "pol1",
  name: "Open Artifacts \u2013 everyone",
  decision: "allow",
  include: [{ everyone: {} }],
  exclude: [],
  require: [],
};
export const app = (name: string, policies = [{ id: "pol1" }]) => ({
  id: `app-${name}`,
  name,
  policies,
  type: "saas",
  saas_app: {
    auth_type: "oidc",
    client_id: `cid-${name}`,
    redirect_uris: ["https://app.example.com/auth/callback"],
  },
});
const paged = (
  items: Obj[],
  q: (k: string) => string | null,
  noInfo?: boolean,
) => {
  const per = Math.min(100, Number(q("per_page") ?? 20)); // API max
  const page = Number(q("page") ?? 1);
  const total_pages = Math.max(1, Math.ceil(items.length / per));
  const result = items.slice((page - 1) * per, page * per);
  const info = { page, per_page: per, total_pages };
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      result,
      ...(noInfo ? {} : { result_info: info }),
    }),
  );
};

/** A stateful fake account: wrangler creates mutate it, the API reads it. */
export function world(w: World = {}) {
  const acct = {
    accounts: ["acc1"],
    zones: ["example.com"],
    d1: [],
    r2: [],
    kv: [],
    ...w,
  };
  const policies: Obj[] = [...(w.policies ?? [])];
  const apps: Obj[] = [...(w.apps ?? [])];
  let secrets = w.secrets && [...w.secrets];
  let deployedConfig: string | undefined;
  let published = 0;
  const deleted = [...(w.deletedArtifacts ?? [])];
  /** Every mutation, in order. `values` holds every secret value seen. */
  const ops: string[] = [];
  const values: string[] = [];
  const creates: string[] = [];
  const auths: string[] = [];
  const zoneQueries: string[] = [];
  /** Every exec argv and env, for leak scans. */
  const argv: string[] = [];
  /** App-host and Access requests, e.g. "GET /healthz", "mcp tools/list". */
  const hits: string[] = [];
  const mcpCalls: Obj[] = [];
  const sqls: string[] = [];
  const db = {
    users: [] as { id: string; email: string; role: string }[],
    tokens: [] as Obj[],
  };
  let healthFails = w.healthFails ?? 0;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const d1 = (sql: string) => {
    sqls.push(sql);
    if (w.d1Fails && sql.includes("INSERT")) throw new Error("D1 down");
    const sel = sql.match(/^SELECT id FROM tokens WHERE id = '([^']*)'/);
    if (sel) return db.tokens.filter((t) => t.id === sel[1] && !t.revoked_at);
    const u = sql.match(
      /INSERT INTO users \(id, email, name, role, created_at\) VALUES \('(\w+)', '((?:[^']|'')*)'/,
    );
    const t = sql.match(
      /INSERT INTO tokens \(id, user_id, label, token_hash, created_at\) SELECT '(\w+)', id, '[^']*', '([0-9a-f]{64})'/,
    );
    if (!u || !t) throw new Error(`fake d1: unexpected SQL ${sql}`);
    const email = u[2].replaceAll("''", "'");
    let user = db.users.find((x) => x.email === email.toLowerCase());
    if (!user) {
      user = { id: u[1], email: email.toLowerCase(), role: "owner" };
      db.users.push(user);
    }
    user.role = "owner";
    const rev = sql.match(
      /UPDATE tokens SET revoked_at = (\d+) WHERE id = '(\w+)' AND revoked_at IS NULL;/,
    );
    for (const x of db.tokens)
      if (rev && x.id === rev[2] && !x.revoked_at)
        x.revoked_at = Number(rev[1]);
    if (!w.dropTokenInsert)
      db.tokens.push({ id: t[1], user_id: user.id, token_hash: t[2] });
    ops.push("d1 owner+token");
    return [];
  };
  const c = core({
    answers: w.answers,
    files: {
      [join(ROOT, TEMPLATE)]: readFileSync(join(realRoot, TEMPLATE), "utf8"),
      [join(ROOT, WELCOME)]: readFileSync(join(realRoot, WELCOME), "utf8"),
      [join(ROOT, "package.json")]:
        '{ "name": "open-artifacts", "version": "0.1.0" }',
      ...(w.state ? { [STATE]: JSON.stringify(w.state) } : {}),
    },
    exec: async (cmd, args, opts) => {
      argv.push(`${cmd} ${args.join(" ")} ${JSON.stringify(opts ?? {})}`);
      if (
        cmd === "pnpm" &&
        !args.includes("wrangler") &&
        args.at(-1) === "build"
      ) {
        ops.push("build");
        return { code: 0, stdout: "built", stderr: "" };
      }
      if (cmd === "pnpm" && args[0] === "--version")
        return { code: 0, stdout: "10.11.1\n", stderr: "" };
      const a = args.slice(args.indexOf("wrangler") + 1).join(" ");
      let stdout = "";
      const [, kind, rest] =
        a.match(/^(d1 create|r2 bucket create|kv namespace create) (.+)$/) ??
        [];
      const put = a.match(/^secret put (\w+) --name [\w-]+$/);
      const del = a.match(/^secret delete (\w+) --name [\w-]+$/);
      const exe = a.match(
        /^d1 execute ([\w-]+) --remote --json --command (.+)$/s,
      );
      const mig = a.match(/^d1 migrations apply ([\w-]+) --remote$/);
      if (a.startsWith("secret list ")) {
        if (!secrets)
          return { code: 1, stdout: "", stderr: 'Worker "x" not found.' };
        stdout = `wrangler 4.151.1 [x]\n${JSON.stringify(secrets.map((name) => ({ name })))}`;
      } else if (put) {
        values.push(opts?.input ?? "");
        if (put[1] === w.putFails)
          return {
            code: 1,
            stdout: opts?.input ?? "",
            stderr: `put failed: ${JSON.stringify(opts?.input)}`,
          };
        ops.push(`put ${put[1]}`);
        secrets = [...(secrets ?? []), put[1]];
      } else if (del) {
        ops.push(`delete secret ${del[1]}`);
        secrets = secrets?.filter((n) => n !== del[1]);
      } else if (exe) {
        try {
          stdout = `wrangler 4.151.1 (update available [4.152])\n${JSON.stringify([{ results: d1(exe[2]), success: true }])}`;
        } catch (e) {
          return { code: 1, stdout: "", stderr: (e as Error).message };
        }
      } else if (mig) ops.push(`migrate ${mig[1]}`);
      else if (a === "deploy") {
        ops.push("deploy");
        deployedConfig = c.files.get(join(ROOT, "apps/server/wrangler.jsonc"));
      } else if (a === "whoami --json") stdout = WHOAMI(acct.accounts);
      else if (a === "auth token --json")
        stdout = '{"type":"oauth","token":"t"}';
      else if (kind === "d1 create")
        acct.d1.push({ uuid: `d1-${acct.d1.length}`, name: rest });
      else if (kind === "r2 bucket create") acct.r2.push({ name: rest });
      else if (kind === "kv namespace create")
        acct.kv.push({ id: `kv-${acct.kv.length}`, title: rest });
      else return { code: 1, stdout: "", stderr: `unknown: ${a}` };
      if (kind) creates.push(a);
      return { code: 0, stdout, stderr: "" };
    },
    fetch: async (input, init) => {
      const u = new URL(String(input));
      const m = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const q = (k: string) => u.searchParams.get(k);
      if (u.host === "app.example.com") {
        if (u.pathname === "/healthz") {
          hits.push("GET /healthz");
          if (healthFails-- > 0)
            return new Response("starting", { status: 503 });
          return Response.json({ ok: true });
        }
        if (u.pathname === "/mcp") {
          const tok = auth?.replace(/^Bearer /, "") ?? "";
          if (
            !db.tokens.some((t) => t.token_hash === sha(tok) && !t.revoked_at)
          )
            return Response.json({ error: "unauthorized" }, { status: 401 });
          hits.push(`mcp ${body.method}`);
          const reply = (result: unknown, sse = false) => {
            const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
            return sse
              ? new Response(`event: message\ndata: ${msg}\n\n`, {
                  headers: { "content-type": "text/event-stream" },
                })
              : new Response(msg, {
                  headers: {
                    "content-type": "application/json",
                    "mcp-session-id": "s1",
                  },
                });
          };
          if (body.method === "initialize")
            return reply({ protocolVersion: "2025-06-18", capabilities: {} });
          if (body.method === "notifications/initialized")
            return new Response(null, { status: 202 });
          if (body.method === "tools/list")
            return reply({
              tools: [
                ...(w.noPublishTool ? [] : [{ name: "publish_artifact" }]),
                { name: "get_artifact" },
              ],
            });
          if (body.method === "tools/call") {
            mcpCalls.push(body.params);
            const prev = body.params.arguments.id;
            const err = (text: string) =>
              reply({ isError: true, content: [{ type: "text", text }] }, true);
            if (w.publishError) return err(w.publishError);
            if (prev && deleted.includes(prev))
              return err("not_found: Artifact not found");
            const id = prev ?? `art${++published}`;
            return reply(
              {
                content: [{ type: "text", text: "Published" }],
                structuredContent: {
                  id,
                  version: 1,
                  url: w.viewUrl ?? `https://app.example.com/a/${id}`,
                },
              },
              true,
            );
          }
        }
        const cu = u.pathname.match(
          /^\/api\/v1\/artifacts\/(\w+)\/content-url$/,
        );
        if (cu) {
          hits.push("GET content-url");
          const tok = auth?.replace(/^Bearer /, "") ?? "";
          if (
            !db.tokens.some((t) => t.token_hash === sha(tok) && !t.revoked_at)
          )
            return Response.json({ error: "unauthorized" }, { status: 401 });
          return Response.json({
            url: `https://a.b.usercontent.example.com/s/sig/${cu[1]}/1/__view`,
            expiresAt: "2026-10-18T00:00:00.000Z",
          });
        }
        return new Response("nf", { status: 404 });
      }
      if (u.host === "a.b.usercontent.example.com") {
        hits.push(`GET content ${auth ? "with auth" : "no auth"}`);
        const last = mcpCalls.at(-1)?.arguments?.content ?? "";
        return new Response(
          w.contentStatus
            ? "denied"
            : (w.contentBody ?? `<html><body>${last}</body></html>`),
          { status: w.contentStatus ?? 200 },
        );
      }
      if (u.host === "team.cloudflareaccess.com") {
        hits.push(`GET ${u.pathname}`);
        return Response.json({ issuer: "https://team.cloudflareaccess.com" });
      }
      const p = u.pathname.replace("/client/v4", "");
      auths.push(`${p} ${auth}`);
      const r2 = p.match(/\/r2\/buckets\/([^/]+)$/);
      const acc = p.match(/\/access\/(organizations|policies|apps)\/?(.*)$/);
      if (acc?.[1] === "organizations") {
        if (w.org === "forbidden" && auth === "Bearer t")
          return envelope(null, 403, [
            { code: 10000, message: "Authentication error" },
          ]);
        if (w.org === "404")
          return envelope(null, 404, [{ code: 7003, message: "not found" }]);
        return envelope(
          w.org === "none"
            ? null
            : { auth_domain: "team.cloudflareaccess.com" },
        );
      }
      if (acc && m === "GET")
        return paged(acc[1] === "apps" ? apps : policies, q, w.noResultInfo);
      if (acc) ops.push(`${m} ${acc[1]}${acc[2] ? `/${acc[2]}` : ""}`);
      if (acc?.[1] === "policies" && m === "POST") {
        policies.push({ ...body, id: "pol1" });
        return envelope({ ...body, id: "pol1" });
      }
      if (acc?.[1] === "policies" && m === "PUT") {
        policies[policies.findIndex((x) => x.id === acc[2])] = {
          ...body,
          id: acc[2],
        };
        return envelope({ ...body, id: acc[2] });
      }
      if (acc?.[1] === "apps" && m === "POST") {
        const made = {
          ...app(body.name, body.policies),
          saas_app: {
            ...body.saas_app,
            client_id: "cid-new",
            client_secret: "CLIENT-SECRET-xyz",
          },
        };
        values.push("CLIENT-SECRET-xyz");
        apps.push(made);
        return envelope({ ...made, created_body: body });
      }
      if (acc?.[1] === "apps" && m === "DELETE") {
        if (w.deleteFails) return envelope(null, 500, [{ message: "boom" }]);
        apps.splice(
          apps.findIndex((x) => x.id === acc[2]),
          1,
        );
        return envelope({ id: acc[2] });
      }
      if (p === "/zones") {
        zoneQueries.push(u.search);
        const ok =
          q("status") === "active" && acct.zones.includes(q("name") ?? "");
        return envelope(ok ? [{ id: "z", name: q("name") }] : []);
      }
      if (p.endsWith("/d1/database"))
        return envelope(acct.d1.filter((d) => d.name === q("name")));
      if (r2) {
        const b = acct.r2.find((x) => x.name === r2[1]);
        return b
          ? envelope(b)
          : envelope(null, 404, [
              { code: 10006, message: "The specified bucket does not exist." },
            ]);
      }
      if (p.endsWith("/storage/kv/namespaces")) return paged(acct.kv, q);
      return envelope(null, 404, [{ message: "no route" }]);
    },
  });
  return {
    ...c,
    argv,
    hits,
    mcpCalls,
    deleted,
    sqls,
    db,
    deployed: () => deployedConfig,
    auths,
    creates,
    zoneQueries,
    acct,
    ops,
    values,
    policies,
    apps,
  };
}

export const HOSTS = [
  ...[
    "--app-host",
    "app.example.com",
    "--content-host",
    "a.b.usercontent.example.com",
  ],
  ...["--owner-email", "owner@example.com", "--yes", "--json"],
];
