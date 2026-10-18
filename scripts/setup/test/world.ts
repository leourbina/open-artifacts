import { readFileSync } from "node:fs";
import { join } from "node:path";
import { core, envelope, ROOT } from "./fakes.ts";

const TEMPLATE = "apps/server/wrangler.template.jsonc";
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
  org?: "forbidden" | "none";
  policies?: Obj[];
  apps?: Obj[];
  /** Worker secret names; undefined means the Worker does not exist yet. */
  secrets?: string[];
  putFails?: string;
  deleteFails?: boolean;
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
  saas_app: { client_id: `cid-${name}` },
});
const paged = (items: Obj[], q: (k: string) => string | null) => {
  const per = Math.min(100, Number(q("per_page") ?? 20)); // API max
  const page = Number(q("page") ?? 1);
  const total_pages = Math.max(1, Math.ceil(items.length / per));
  const result = items.slice((page - 1) * per, page * per);
  const info = { page, per_page: per, total_pages };
  return new Response(
    JSON.stringify({ success: true, errors: [], result, result_info: info }),
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
  /** Every mutation, in order. `values` holds every secret value seen. */
  const ops: string[] = [];
  const values: string[] = [];
  const creates: string[] = [];
  const zoneQueries: string[] = [];
  const c = core({
    answers: w.answers,
    files: {
      [join(ROOT, TEMPLATE)]: readFileSync(join(realRoot, TEMPLATE), "utf8"),
    },
    exec: async (cmd, args, opts) => {
      if (cmd === "pnpm" && args[0] === "--version")
        return { code: 0, stdout: "10.11.1\n", stderr: "" };
      const a = args.slice(args.indexOf("wrangler") + 1).join(" ");
      let stdout = "";
      const [, kind, rest] =
        a.match(/^(d1 create|r2 bucket create|kv namespace create) (.+)$/) ??
        [];
      const put = a.match(/^secret put (\w+) --name [\w-]+$/);
      if (a.startsWith("secret list ")) {
        if (!secrets)
          return { code: 1, stdout: "", stderr: 'Worker "x" not found.' };
        stdout = JSON.stringify(secrets.map((name) => ({ name })));
      } else if (put) {
        values.push(opts?.input ?? "");
        if (put[1] === w.putFails)
          return { code: 1, stdout: "", stderr: "put failed" };
        ops.push(`put ${put[1]}`);
        secrets = [...(secrets ?? []), put[1]];
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
      const p = u.pathname.replace("/client/v4", "");
      const r2 = p.match(/\/r2\/buckets\/([^/]+)$/);
      const acc = p.match(/\/access\/(organizations|policies|apps)\/?(.*)$/);
      if (acc?.[1] === "organizations") {
        if (w.org === "forbidden" && auth === "Bearer t")
          return envelope(null, 403, [
            { code: 10000, message: "Authentication error" },
          ]);
        return envelope(
          w.org === "none"
            ? null
            : { auth_domain: "team.cloudflareaccess.com" },
        );
      }
      if (acc && m === "GET")
        return paged(acc[1] === "apps" ? apps : policies, q);
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
  return { ...c, creates, zoneQueries, acct, ops, values, policies, apps };
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
