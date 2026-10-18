// B4 staging step: idempotently provision the Access for SaaS OIDC app and the
// staging Worker secrets. Run via .github/workflows/ops-staging-access.yml.
// Never log secret values: every secret goes through out.mask() first and is
// passed to wrangler on stdin only.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_NAME = "open-artifacts-staging";
// Spec 6.5: Access lets everyone authenticate; the app does authorization.
export const POLICY_NAME = "Open Artifacts \u2013 everyone";
export const LEGACY_POLICY_NAME = "open-artifacts-staging-owner";
const POLICY_BODY = {
  name: POLICY_NAME,
  decision: "allow",
  include: [{ everyone: {} }],
  exclude: [],
  require: [],
  approval_required: false,
  isolation_required: false,
  purpose_justification_required: false,
};
// Non-spec optional fields kept from an existing policy on reconcile.
const CARRY_OVER = ["session_duration"] as const;
export const REDIRECT_URI = "https://staging.open-artifacts.com/auth/callback";

export type Api = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<Obj>;
export type Wrangler = {
  list: () => Promise<string[]>;
  put: (name: string, value: string) => Promise<void>;
};
export type Out = {
  log: (s: string) => void;
  summary: (s: string) => void;
  mask: (s: string) => void;
};
export type Options = {
  accountId: string;
  teamName: string;
  forceRotate: boolean;
  configTeamDomain?: string;
  api: Api;
  wrangler: Wrangler;
  generate: () => string;
  out: Out;
};

// biome-ignore lint/suspicious/noExplicitAny: untyped API objects
type Obj = any;

async function listAll(api: Api, path: string): Promise<Obj[]> {
  const items: Obj[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await api("GET", `${path}?per_page=100&page=${page}`);
    const batch: Obj[] = Array.isArray(r) ? r : [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function teamDomain(o: Options): Promise<string> {
  let why = "empty auth_domain";
  try {
    const org = await o.api(
      "GET",
      `/accounts/${o.accountId}/access/organizations`,
    );
    if (typeof org?.auth_domain === "string" && org.auth_domain)
      return org.auth_domain;
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  o.out.log(
    `organizations lookup fell back (${why}); using team_name=${o.teamName}`,
  );
  return `${o.teamName}.cloudflareaccess.com`;
}

const empty = (x: unknown) =>
  x === undefined || x === null || (Array.isArray(x) && x.length === 0);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) => Object.hasOwn(b, k) && deepEqual((a as Obj)[k], (b as Obj)[k]),
  );
}

function policyMatches(p: Obj): boolean {
  return (
    p.name === POLICY_NAME &&
    p.decision === POLICY_BODY.decision &&
    deepEqual(p.include ?? [], POLICY_BODY.include) &&
    empty(p.exclude) &&
    empty(p.require) &&
    !p.approval_required &&
    !p.isolation_required &&
    !p.purpose_justification_required
  );
}

// Reusable policies are small, so PUT (full replace) is safe here; the app is
// never PUT. Renaming the legacy policy keeps its id, so app links stay valid.
async function ensurePolicy(o: Options): Promise<string> {
  const base = `/accounts/${o.accountId}/access/policies`;
  const all = await listAll(o.api, base);
  const found =
    all.find((p) => p.name === POLICY_NAME) ??
    all.find((p) => p.name === LEGACY_POLICY_NAME);
  if (found) {
    if (policyMatches(found)) {
      o.out.log(`policy ${POLICY_NAME}: unchanged (${found.id})`);
    } else {
      const kept: Obj = {};
      for (const k of CARRY_OVER)
        if (found[k] !== undefined) kept[k] = found[k];
      await o.api("PUT", `${base}/${found.id}`, { ...kept, ...POLICY_BODY });
      o.out.log(`policy ${POLICY_NAME}: reconciled (${found.id})`);
    }
    return found.id;
  }
  const p = await o.api("POST", base, POLICY_BODY);
  o.out.log(`policy ${POLICY_NAME}: created (${p.id})`);
  return p.id;
}

const ALL = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
  "CF_ACCOUNT_ID",
];

export async function run(o: Options) {
  // ---- preflight: nothing below mutates the Access app ----
  const domain = await teamDomain(o);
  const existing = new Set(await o.wrangler.list());
  const policyId = await ensurePolicy(o);
  const appsPath = `/accounts/${o.accountId}/access/apps`;
  const app = (await listAll(o.api, appsPath)).find((a) => a.name === APP_NAME);

  if (app) {
    o.out.log(`app ${APP_NAME}: exists (${app.id})`);
    const links: Obj[] = app.policies ?? [];
    if (!links.some((p) => p.id === policyId)) {
      throw new Error(
        `Access app ${APP_NAME} exists but is not linked to policy ${POLICY_NAME}. Either attach ${POLICY_NAME} to the app in the dashboard (Zero Trust > Access > Applications > ${APP_NAME} > Policies), or delete the app and re-run this workflow.`,
      );
    }
    if (!app.saas_app?.client_id)
      throw new Error(`app ${APP_NAME} has no saas_app.client_id`);
    if (!existing.has("ACCESS_CLIENT_SECRET")) {
      throw new Error(
        `ACCESS_CLIENT_SECRET is missing on the Worker and cannot be recovered: Access app ${APP_NAME} already exists, the API only returns its OIDC client_secret on creation and offers no rotate endpoint. Delete the Access app (Zero Trust > Access > Applications) and re-run this workflow, or copy the secret from the dashboard into \`wrangler secret put ACCESS_CLIENT_SECRET\`.`,
      );
    }
  }

  const plan: [string, string][] = [];
  for (const name of ["SESSION_SECRET", "CONTENT_SIGNING_KEY"]) {
    if (o.forceRotate || !existing.has(name)) {
      const v = o.generate().trim();
      if (v.length < 32)
        throw new Error(`${name}: generated value must be at least 32 chars`);
      o.out.mask(v);
      plan.push([name, v]);
    }
  }
  if (!existing.has("CF_ACCOUNT_ID")) plan.push(["CF_ACCOUNT_ID", o.accountId]);

  const set: string[] = [];
  const put = async (name: string, v: string) => {
    o.out.mask(v);
    await o.wrangler.put(name, v);
    o.out.log(`secret ${name}: set`);
    set.push(name);
  };

  let clientId: string;
  if (app) {
    clientId = app.saas_app.client_id;
    for (const [n, v] of plan) await put(n, v);
  } else {
    const created = await o.api("POST", appsPath, {
      name: APP_NAME,
      type: "saas",
      policies: [{ id: policyId, precedence: 1 }],
      saas_app: {
        auth_type: "oidc",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code_with_pkce"],
        allow_pkce_without_client_secret: false,
        scopes: ["openid", "email", "profile"],
      },
    });
    const secret: unknown = created?.saas_app?.client_secret;
    if (typeof secret === "string" && secret) o.out.mask(secret);
    o.out.log(`app ${APP_NAME}: created (${created?.id})`);
    try {
      if (typeof secret !== "string" || !secret)
        throw new Error(
          `POST ${appsPath} response lacks saas_app.client_secret`,
        );
      const id: unknown = created.saas_app.client_id;
      if (typeof id !== "string" || !id)
        throw new Error(`POST ${appsPath} response lacks saas_app.client_id`);
      clientId = id;
      await put("ACCESS_CLIENT_SECRET", secret);
      for (const [n, v] of plan) await put(n, v);
    } catch (e) {
      if (created?.id) {
        o.out.log(`rolling back: deleting app ${APP_NAME} (${created.id})`);
        try {
          await o.api("DELETE", `${appsPath}/${created.id}`);
        } catch (d) {
          const msg = (x: unknown) =>
            x instanceof Error ? x.message : String(x);
          o.out.log(
            `rollback DELETE failed: ${msg(d)}; original error: ${msg(e)}`,
          );
        }
      }
      throw e;
    }
  }

  const skipped = ALL.filter((n) => !set.includes(n));
  for (const n of skipped) o.out.log(`secret ${n}: already set, skipped`);

  const warn =
    o.configTeamDomain && o.configTeamDomain !== domain
      ? [
          `> **Warning:** discovered team domain \`${domain}\` differs from ACCESS_TEAM_DOMAIN \`${o.configTeamDomain}\` in wrangler.staging.jsonc.`,
          "",
        ]
      : [];
  o.out.summary(
    [
      "## Staging Access setup",
      "",
      ...warn,
      "| Var | Value |",
      "|---|---|",
      `| ACCESS_CLIENT_ID | \`${clientId}\` |`,
      `| ACCESS_TEAM_DOMAIN | \`${domain}\` |`,
      "",
      `Secrets set: ${set.join(", ") || "none"}`,
      "",
      `Secrets skipped: ${skipped.join(", ") || "none"}`,
      "",
      "Commit ACCESS_CLIENT_ID into `apps/server/wrangler.staging.jsonc` vars.",
      "",
    ].join("\n"),
  );
  return { clientId, teamDomain: domain, set, skipped };
}

export function parseSecretList(raw: string): string[] {
  const i = raw.indexOf("[");
  if (i < 0)
    throw new Error(
      "wrangler secret list returned no JSON array (check auth and that the Worker exists)",
    );
  return (JSON.parse(raw.slice(i)) as { name: string }[]).map((s) => s.name);
}

export function readConfigTeamDomain(file: string): string | undefined {
  const m = readFileSync(file, "utf8").match(
    /"ACCESS_TEAM_DOMAIN"\s*:\s*"([^"]*)"/,
  );
  return m?.[1] || undefined;
}

// ---- production wiring ----

export function cfApi(token: string, fetchImpl: typeof fetch = fetch): Api {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok || json.success === false) {
      const errs = (json.errors ?? [])
        .map((e: Obj) => `${e.code}: ${e.message}`)
        .join("; ");
      throw new Error(
        `${method} ${path.split("?")[0]} failed (${res.status}) ${errs}`,
      );
    }
    return json.result;
  };
}

const serverDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/server",
);
const WRANGLER_ARGS = ["-c", "wrangler.staging.jsonc", "--env", "staging"];

export const cliWrangler: Wrangler = {
  list: async () => {
    const raw = execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "secret",
        "list",
        "--format",
        "json",
        ...WRANGLER_ARGS,
      ],
      {
        cwd: serverDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    return parseSecretList(raw);
  },
  put: async (name, value) => {
    execFileSync(
      "pnpm",
      ["exec", "wrangler", "secret", "put", name, ...WRANGLER_ARGS],
      {
        cwd: serverDir,
        input: value,
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
  },
};

async function main() {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const token = need("CLOUDFLARE_API_TOKEN");
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  await run({
    accountId: need("CLOUDFLARE_ACCOUNT_ID"),
    teamName: process.env.TEAM_NAME || "leourbina",
    forceRotate: process.env.FORCE_ROTATE === "true",
    configTeamDomain: readConfigTeamDomain(
      join(serverDir, "wrangler.staging.jsonc"),
    ),
    api: cfApi(token),
    wrangler: cliWrangler,
    generate: () =>
      execFileSync("openssl", ["rand", "-base64", "48"], {
        encoding: "utf8",
      }).trim(),
    out: {
      log: (s) => console.log(s),
      summary: (s) =>
        summaryFile ? appendFileSync(summaryFile, s) : console.log(s),
      mask: (s) => {
        for (const line of s.split("\n"))
          if (line) console.log(`::add-mask::${line}`);
      },
    },
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e: unknown) => {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
