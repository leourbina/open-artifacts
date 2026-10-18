// B4 staging step: idempotently provision the Access for SaaS OIDC app and the
// staging Worker secrets. Run via .github/workflows/ops-staging-access.yml.
// Never log secret values: every secret goes through out.mask() first and is
// passed to wrangler on stdin only.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_NAME = "open-artifacts-staging";
export const POLICY_NAME = "open-artifacts-staging-owner";
export const OWNER_EMAIL = "me@leourbina.com";
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
  try {
    const org = await o.api(
      "GET",
      `/accounts/${o.accountId}/access/organizations`,
    );
    if (typeof org?.auth_domain === "string" && org.auth_domain)
      return org.auth_domain;
  } catch {
    // fall through to the team_name input
  }
  o.out.log(
    `organizations lookup empty or failed; using team_name=${o.teamName}`,
  );
  return `${o.teamName}.cloudflareaccess.com`;
}

async function ensurePolicy(o: Options): Promise<string> {
  const base = `/accounts/${o.accountId}/access/policies`;
  const found = (await listAll(o.api, base)).find(
    (p) => p.name === POLICY_NAME,
  );
  if (found) {
    o.out.log(`policy ${POLICY_NAME}: exists (${found.id})`);
    return found.id;
  }
  const p = await o.api("POST", base, {
    name: POLICY_NAME,
    decision: "allow",
    include: [{ email: { email: OWNER_EMAIL } }],
  });
  o.out.log(`policy ${POLICY_NAME}: created (${p.id})`);
  return p.id;
}

const READ_ONLY = ["id", "uid", "aud", "created_at", "updated_at", "domain"];

async function ensureApp(
  o: Options,
  policyId: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const base = `/accounts/${o.accountId}/access/apps`;
  const app = (await listAll(o.api, base)).find((a) => a.name === APP_NAME);
  if (app) {
    o.out.log(`app ${APP_NAME}: exists (${app.id})`);
    const links: Obj[] = app.policies ?? [];
    if (!links.some((p) => p.id === policyId)) {
      const body: Obj = { ...app };
      for (const k of READ_ONLY) delete body[k];
      body.saas_app = { ...app.saas_app };
      delete body.saas_app.client_secret;
      delete body.saas_app.created_at;
      delete body.saas_app.updated_at;
      body.policies = [
        ...links.map((p) => ({ id: p.id, precedence: p.precedence })),
        { id: policyId, precedence: links.length + 1 },
      ];
      await o.api("PUT", `${base}/${app.id}`, body);
      o.out.log(`app ${APP_NAME}: linked policy ${POLICY_NAME}`);
    }
    return { clientId: app.saas_app?.client_id };
  }
  const created = await o.api("POST", base, {
    name: APP_NAME,
    type: "saas",
    policies: [{ id: policyId, precedence: 1 }],
    saas_app: {
      auth_type: "oidc",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code"],
      scopes: ["openid", "email", "profile"],
    },
  });
  const clientSecret: string | undefined = created.saas_app?.client_secret;
  if (clientSecret) o.out.mask(clientSecret);
  o.out.log(`app ${APP_NAME}: created (${created.id})`);
  return { clientId: created.saas_app?.client_id, clientSecret };
}

export async function run(o: Options) {
  const domain = await teamDomain(o);
  const policyId = await ensurePolicy(o);
  const { clientId, clientSecret } = await ensureApp(o, policyId);
  if (!clientId) throw new Error(`app ${APP_NAME} has no saas_app.client_id`);

  const existing = new Set(await o.wrangler.list());
  const plan: [string, () => string][] = [];

  if (clientSecret) {
    // New app: its secret supersedes any stale Worker value.
    plan.push(["ACCESS_CLIENT_SECRET", () => clientSecret]);
  } else if (!existing.has("ACCESS_CLIENT_SECRET")) {
    throw new Error(
      `ACCESS_CLIENT_SECRET is missing on the Worker and cannot be recovered: Access app ${APP_NAME} already exists, the API only returns its OIDC client_secret on creation and offers no rotate endpoint. Delete the Access app (Zero Trust > Access > Applications) and re-run this workflow, or copy the secret from the dashboard into \`wrangler secret put ACCESS_CLIENT_SECRET\`.`,
    );
  }
  for (const name of ["SESSION_SECRET", "CONTENT_SIGNING_KEY"]) {
    if (o.forceRotate || !existing.has(name)) {
      plan.push([
        name,
        () => {
          const v = o.generate().trim();
          if (v.length < 32)
            throw new Error(
              `${name}: generated value must be at least 32 chars`,
            );
          return v;
        },
      ]);
    }
  }
  if (!existing.has("CF_ACCOUNT_ID"))
    plan.push(["CF_ACCOUNT_ID", () => o.accountId]);

  const set: string[] = [];
  for (const [name, value] of plan) {
    const v = value();
    o.out.mask(v);
    await o.wrangler.put(name, v);
    o.out.log(`secret ${name}: set`);
    set.push(name);
  }
  const all = [
    "ACCESS_CLIENT_SECRET",
    "SESSION_SECRET",
    "CONTENT_SIGNING_KEY",
    "CF_ACCOUNT_ID",
  ];
  const skipped = all.filter((n) => !set.includes(n));
  for (const n of skipped) o.out.log(`secret ${n}: already set, skipped`);

  o.out.summary(
    [
      "## Staging Access setup",
      "",
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
    const parsed = JSON.parse(raw.slice(raw.indexOf("["))) as {
      name: string;
    }[];
    return parsed.map((s) => s.name);
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
