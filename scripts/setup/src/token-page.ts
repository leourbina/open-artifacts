import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { parseArgs } from "node:util";
import { type Deps, makeApi, makeWrangler, realFs } from "./cf.ts";
import { readOnlyDeps } from "./readonly.ts";
import { readState } from "./state.ts";
import type { Ctx } from "./step.ts";
import { zoneOf } from "./steps/prereqs.ts";
import {
  type LinkedToken,
  type StoreAs,
  tokens,
  withUrls,
  type Zone,
} from "./tokens.ts";

/** The page template (a copy of design/setup/token-page.html with fields). */
export const TEMPLATE_PATH = new URL("../token-page.html", import.meta.url)
  .pathname;
const IDLE_MS = 30 * 60_000;

const esc = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const storeLine = (s: StoreAs) =>
  s.kind === "gh-secret" ? s.command : `read -rs ${s.name} && export ${s.name}`;
const STORE_LEAD = {
  "gh-secret":
    "Run the line below. It prompts for the value, so the token never shows on screen or in a transcript:",
  env: "In the terminal where you'll run setup, run the line below and paste the token when it waits. Nothing is shown:",
};

function region(tpl: string, name: string) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const a = tpl.indexOf(start);
  const b = tpl.indexOf(end);
  if (a < 0 || b < a) throw new Error(`token page template: no ${name} region`);
  return {
    before: tpl.slice(0, a),
    item: tpl.slice(a + start.length, b).trim(),
    after: tpl.slice(b + end.length),
  };
}

function fill(item: string, fields: Record<string, string>, raw: Set<string>) {
  return item.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = fields[k];
    if (v === undefined) throw new Error(`token page template: no {{${k}}}`);
    return raw.has(k) ? v : esc(v);
  });
}

/** The page for these tokens: one progress item and one card each, every value escaped. */
export function renderTokenPage(list: LinkedToken[], template: string): string {
  // The header comment documents the fields; it is not shipped.
  let html = template.replace(/<!--[\s\S]*?-->\n?/, "");
  const raw = new Set(["chips", "optionalTag", "zoneStep"]);
  const names = (z: string[]) =>
    z.length < 2
      ? `<b>${esc(z[0] ?? "")}</b>`
      : `${z
          .slice(0, -1)
          .map((n) => `<b>${esc(n)}</b>`)
          .join(", ")} and <b>${esc(z.at(-1) as string)}</b>`;
  const fields = (t: LinkedToken, i: number) => {
    const readOnly = t.permissions.every((p) => p.type === "read");
    const zoned = Boolean(t.zoneScope);
    const label = `${t.id} token`;
    return {
      id: t.id,
      label: `${label[0]?.toUpperCase()}${label.slice(1)}`,
      n: String(i + 1),
      total: String(list.length),
      scope: readOnly ? "read-only" : zoned ? "account and zone" : "account",
      title: `Create the ${label}`,
      name: t.name,
      purpose: t.purpose,
      url: t.url,
      chips: t.permissions.map((p) => `<code>${esc(p.label)}</code>`).join(""),
      store: storeLine(t.storeAs),
      storeLead: STORE_LEAD[t.storeAs.kind],
      optional: t.required ? "" : " · optional",
      optionalTag: t.required ? "" : " <span>optional</span>",
      zoneStep: t.zoneScope
        ? `<li><div><span class="st">Limit it to your ${t.zoneScope.zones.length > 1 ? "zones" : "zone"}</span><p>Under Zone Resources, change All zones to Specific zone → ${names(t.zoneScope.zones)}. The link can't preselect ${t.zoneScope.zones.length > 1 ? "them" : "it"}.</p></div></li>`
        : "",
    };
  };
  for (const name of ["progress", "token"]) {
    const r = region(html, name);
    const items = list.map((t, i) => fill(r.item, fields(t, i), raw));
    const sep = name === "progress" ? "\n      " : "\n\n  ";
    html = `${r.before.trimEnd()}${sep}${items.join(sep)}\n${r.after.replace(/^\n/, "")}`;
  }
  return html;
}

export type Served = {
  server: Server;
  url: string;
  close: () => void;
  closed: Promise<void>;
};

/** Serves `html` on 127.0.0.1 (random port) until close() or `idleMs` without a request. */
export function serveTokenPage(
  html: string,
  o: { idleMs?: number } = {},
): Promise<Served> {
  const idleMs = o.idleMs ?? IDLE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(close, idleMs);
  };
  const server = createServer((req, res) => {
    arm();
    if (req.method !== "GET" || (req.url ?? "/").split("?")[0] !== "/") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      })
      .end(html);
  });
  let done: () => void = () => {};
  const closed = new Promise<void>((r) => {
    done = r;
  });
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    if (timer) clearTimeout(timer);
    server.close(() => done());
    server.closeAllConnections();
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      arm();
      resolve({ server, url: `http://127.0.0.1:${port}/`, close, closed });
    });
  });
}

const TOKEN_FLAGS = ["--token-links", "--token-page"];
export const isTokenCommand = (argv: string[]) =>
  argv.some((a) => TOKEN_FLAGS.includes(a));

/** Best effort, read-only: the zones holding the hosts, when the login can see them. */
async function detectZones(
  deps: Deps,
  root: string,
  accountId: string,
  hosts: string[],
): Promise<Zone[] | undefined> {
  const ro = readOnlyDeps(deps);
  const wrangler = makeWrangler(ro, root, () => accountId);
  const ctx = { api: makeApi(ro, wrangler) } as unknown as Ctx;
  const zones: Zone[] = [];
  try {
    for (const h of hosts) {
      const z = await zoneOf(ctx, accountId, h);
      if (z && !zones.some((x) => x.id === z.id)) zones.push(z);
    }
  } catch {
    return undefined;
  }
  return zones.length ? zones : undefined;
}

const opener = () =>
  process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "explorer"
      : "xdg-open";

/** --token-links / --token-page: needs no hosts or credentials; writes nothing. */
export async function tokenCommand(
  argv: string[],
  deps: Deps,
  root: string,
): Promise<number> {
  const json = argv.includes("--json");
  const fail = (message: string) => {
    deps.out(
      json
        ? JSON.stringify({ step: "args", status: "error", message })
        : `✗ args: ${message}`,
    );
    return 1;
  };
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: argv,
      strict: true,
      options: {
        "token-links": { type: "boolean" },
        "token-page": { type: "boolean" },
        "no-open": { type: "boolean" },
        json: { type: "boolean" },
        name: { type: "string" },
        "app-host": { type: "string" },
        "content-host": { type: "string" },
        "account-id": { type: "string" },
        repo: { type: "string" },
      },
    }).values;
  } catch (e) {
    return fail(
      `${(e as Error).message} (--token-links/--token-page take --json, --no-open, --name, --app-host, --content-host, --account-id, --repo)`,
    );
  }
  const repo = v.repo as string | undefined;
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo))
    return fail(`invalid --repo: ${JSON.stringify(repo)} (owner/name)`);
  const state = readState(deps.fs ?? realFs, root);
  const name = (v.name as string | undefined) ?? state.name;
  const accountId =
    (v["account-id"] as string | undefined) ??
    state.accountId ??
    deps.env.CLOUDFLARE_ACCOUNT_ID;
  const hosts = [
    (v["app-host"] as string | undefined) ?? state.appHost,
    (v["content-host"] as string | undefined) ?? state.contentHost,
  ].filter((h): h is string => Boolean(h));
  const zones =
    accountId && hosts.length
      ? await detectZones(deps, root, accountId, hosts)
      : undefined;
  const list = withUrls(tokens({ name, repo }), { accountId, zones });

  if (v["token-links"]) {
    if (json)
      deps.out(
        JSON.stringify({
          step: "token-links",
          status: "ok",
          data: { tokens: list },
        }),
      );
    else
      for (const t of list)
        deps.out(
          [
            `${t.name}${t.required ? "" : " (optional)"}: ${t.purpose}`,
            `  permissions: ${t.permissions.map((p) => p.label).join(", ")}`,
            `  create: ${t.url}`,
            ...(t.zoneScope
              ? [
                  `  zones: under Zone Resources pick Specific zone: ${t.zoneScope.zones.join(", ")}`,
                ]
              : []),
            `  store: ${storeLine(t.storeAs)}`,
            `  next: ${t.next}`,
          ].join("\n"),
        );
    if (!v["token-page"]) return 0;
  }

  const html = renderTokenPage(list, readFileSync(TEMPLATE_PATH, "utf8"));
  const s = await serveTokenPage(html);
  deps.out(
    json
      ? JSON.stringify({
          step: "token-page",
          status: "ok",
          message: "serving on 127.0.0.1; stops on Ctrl-C or after 30 min idle",
          data: { tokenPage: { url: s.url } },
        })
      : `✓ token-page: ${s.url} (Ctrl-C to stop; stops after 30 min idle)`,
  );
  if (!v["no-open"]) void deps.exec(opener(), [s.url]).catch(() => undefined);
  const on =
    deps.onSignal ??
    ((sig, h) => {
      process.on(sig, h);
      return () => void process.off(sig, h);
    });
  const unsub = [on("SIGINT", s.close), on("SIGTERM", s.close)];
  await s.closed;
  for (const u of unsub) u();
  return 0;
}
