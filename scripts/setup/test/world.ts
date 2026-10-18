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
  const creates: string[] = [];
  const zoneQueries: string[] = [];
  const c = core({
    answers: w.answers,
    files: {
      [join(ROOT, TEMPLATE)]: readFileSync(join(realRoot, TEMPLATE), "utf8"),
    },
    exec: async (cmd, args) => {
      if (cmd === "pnpm" && args[0] === "--version")
        return { code: 0, stdout: "10.11.1\n", stderr: "" };
      const a = args.slice(args.indexOf("wrangler") + 1).join(" ");
      let stdout = "";
      const [, kind, rest] =
        a.match(/^(d1 create|r2 bucket create|kv namespace create) (.+)$/) ??
        [];
      if (a === "whoami --json") stdout = WHOAMI(acct.accounts);
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
    fetch: async (input) => {
      const u = new URL(String(input));
      const q = (k: string) => u.searchParams.get(k);
      const p = u.pathname.replace("/client/v4", "");
      const r2 = p.match(/\/r2\/buckets\/([^/]+)$/);
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
      if (p.endsWith("/storage/kv/namespaces")) {
        const per = Math.min(100, Number(q("per_page") ?? 20)); // API max
        const page = Number(q("page") ?? 1);
        const total_pages = Math.max(1, Math.ceil(acct.kv.length / per));
        const body = {
          success: true,
          errors: [],
          result: acct.kv.slice((page - 1) * per, page * per),
          result_info: { page, per_page: per, total_pages },
        };
        return new Response(JSON.stringify(body));
      }
      return envelope(null, 404, [{ message: "no route" }]);
    },
  });
  return { ...c, creates, zoneQueries, acct };
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
