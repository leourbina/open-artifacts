// Upload metadata for one user Worker, in Cloudflare's multipart upload format.
// Format: https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
// Bindings: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
// The same metadata works for `/workers/scripts/{name}` (account) and the
// dispatch-namespace endpoint; only the target URL differs (not decided here).
import { readFileSync } from "node:fs";
import { names } from "./names.js";
import type { InstallId } from "./types.js";

/** Remove // and /* *\/ comments and trailing commas, leaving strings intact. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// biome-ignore lint/suspicious/noExplicitAny: the template is arbitrary JSON
export type Template = Record<string, any>;

export function parseTemplate(text: string): Template {
  return JSON.parse(stripJsonc(text)) as Template;
}

let cached: Template | undefined;
export function loadTemplate(): Template {
  cached ??= parseTemplate(
    readFileSync(
      new URL("../../../apps/server/wrangler.template.jsonc", import.meta.url),
      "utf8",
    ),
  );
  return cached;
}

/** Template entries hosted does not upload as bindings, each with a reason. */
export const TEMPLATE_BINDINGS_EXCLUDED: Record<string, string> = {
  routes: "custom domains are attached separately by the provisioner",
  triggers: "crons run from the central scheduler, not per install",
  ANALYTICS_TOKEN: "an account analytics token would expose every install",
  ACCESS_TEAM_DOMAIN: "hosted signs in directly, without Access (P2)",
  ACCESS_CLIENT_ID: "hosted signs in directly, without Access (P2)",
  CF_ACCOUNT_ID: "only feeds the Usage page, which is off in hosted",
  OAUTH_KV_ID: "only feeds the Usage page, which is off in hosted",
};

/** Hosted-only names this module adds beyond the template. */
export const HOSTED_ADDED = [
  "HOSTED",
  "INSTALL_ID",
  "FEATURES",
  "EMAIL_DAILY_CAP",
  "CODE_EMAILS_PER_DAY",
  "AUTH_PROVIDERS",
  "AUTH_DOMAINS",
  "AUTH_BROKER_URL",
  "TEST_HOOKS",
  "TEST_HOOK_KEY",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
] as const;

const SECRETS = ["SESSION_SECRET", "CONTENT_SIGNING_KEY"] as const;

const posInt = (v: string) =>
  /^[1-9]\d{0,8}$/.test(v) ? undefined : "expected a positive integer";
const list = (re: RegExp) => (v: string) =>
  v.split(",").every((x) => re.test(x.trim()))
    ? undefined
    : "expected a comma-separated list";

/** Vars a caller may pass; anything else throws. */
export const HOSTED_VARS: Record<string, (v: string) => string | undefined> = {
  INSTALL_ID: (v) => (/^i[a-z0-9]{11}$/.test(v) ? undefined : "bad install id"),
  FEATURES: list(/^[a-z][a-z0-9_]*$/),
  EMAIL_DAILY_CAP: posInt,
  CODE_EMAILS_PER_DAY: posInt,
  AUTH_PROVIDERS: list(/^[a-z][a-z0-9_-]*$/),
  AUTH_DOMAINS: list(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i),
  AUTH_BROKER_URL: (v) =>
    /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/\S*)?$/i.test(v)
      ? undefined
      : "expected an https URL",
  EMAIL_FROM: (v) =>
    /^[^\s@<>]+@[^\s@<>]+$/.test(v) ? undefined : "expected an email address",
};

export type Binding = { type: string; name: string; [k: string]: unknown };

export interface UploadMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: Binding[];
  observability: {
    enabled: true;
    logs: { enabled: true; invocation_logs: false; head_sampling_rate: 1 };
  };
  tags: string[];
  assets: {
    jwt?: string;
    config: {
      not_found_handling: "single-page-application";
      run_worker_first: true;
    };
  };
  migrations?: {
    old_tag?: string;
    new_tag: string;
    steps: Record<string, unknown>[];
  };
  keep_bindings?: string[];
}

export interface InstallMetaInput {
  id: InstallId;
  appHost: string;
  contentHost: string;
  ownerEmail: string;
  vars: Record<string, string>;
  testHooks: boolean;
}

export interface ResourceMetaInput {
  d1Id: string;
  kvId: string;
  version: string;
  rlNs: number;
  doMigrationTag: string | null;
  namespace: "account" | "oa-staging" | "oa-prod";
  secrets?: Record<string, string>;
  mainModule: string;
  /** Test seam; defaults to apps/server/wrangler.template.jsonc. */
  template?: Template;
}

function migrationsFor(
  template: Template,
  current: string | null,
): UploadMetadata["migrations"] {
  const all = (template.migrations ?? []) as {
    tag: string;
    [k: string]: unknown;
  }[];
  if (all.length === 0) return undefined;
  const latest = (all[all.length - 1] as { tag: string }).tag;
  const stepOf = ({ tag: _t, ...rest }: { tag: string }) => rest;
  if (current === null) {
    return { new_tag: latest, steps: all.map(stepOf) };
  }
  const idx = all.findIndex((m) => m.tag === current);
  if (idx < 0)
    throw new Error(`unknown Durable Object migration tag: ${current}`);
  if (idx === all.length - 1) return undefined;
  return {
    old_tag: current,
    new_tag: latest,
    steps: all.slice(idx + 1).map(stepOf),
  };
}

export function userWorkerMetadata(
  i: InstallMetaInput,
  r: ResourceMetaInput,
): UploadMetadata {
  if (i.testHooks && r.namespace === "oa-prod")
    throw new Error("test hooks are not allowed in oa-prod");
  const t = r.template ?? loadTemplate();
  const n = names(i.id);

  // vars: allowlist first
  for (const [k, v] of Object.entries(i.vars)) {
    const check = Object.hasOwn(HOSTED_VARS, k) ? HOSTED_VARS[k] : undefined;
    if (!check) throw new Error(`unknown var ${JSON.stringify(k)}`);
    const why = check(v);
    if (why) throw new Error(`invalid var ${k}: ${why}`);
  }
  if (i.vars.INSTALL_ID !== undefined && i.vars.INSTALL_ID !== i.id)
    throw new Error("INSTALL_ID must equal the install id");

  const features = [
    ...new Set(
      (i.vars.FEATURES ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .concat("usage_off"),
    ),
  ].join(",");

  const fill: Record<string, string> = {
    WORKER_NAME: n.script,
    APP_HOST: i.appHost,
    CONTENT_HOST: i.contentHost,
    OWNER_EMAIL: i.ownerEmail,
    D1_NAME: n.d1,
    D1_ID: r.d1Id,
    R2_BUCKET: n.r2,
    KV_ID: r.kvId,
    ...(i.vars.EMAIL_FROM === undefined
      ? {}
      : { EMAIL_FROM: i.vars.EMAIL_FROM }),
  };
  const render = (s: string, where: string) => {
    const out = s.replace(/\{\{(\w+)\}\}/g, (m, k: string) =>
      Object.hasOwn(fill, k) ? (fill[k] as string) : m,
    );
    if (out.includes("{{"))
      throw new Error(`unfilled template placeholder in ${where}: ${out}`);
    return out;
  };

  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(
    (t.vars ?? {}) as Record<string, string>,
  )) {
    if (Object.hasOwn(TEMPLATE_BINDINGS_EXCLUDED, k)) continue;
    plain[k] = render(v, `var ${k}`);
  }
  Object.assign(plain, {
    PLAN: "paid",
    ENVIRONMENT: "production",
    HOSTED: "1",
    INSTALL_ID: i.id,
    FEATURES: features,
  });
  for (const k of [
    "EMAIL_DAILY_CAP",
    "CODE_EMAILS_PER_DAY",
    "AUTH_PROVIDERS",
    "AUTH_DOMAINS",
    "AUTH_BROKER_URL",
  ]) {
    const v = i.vars[k];
    if (v !== undefined) plain[k] = v;
  }
  if (i.testHooks) plain.TEST_HOOKS = "1";

  const bindings: Binding[] = Object.entries(plain).map(([name, text]) => ({
    type: "plain_text",
    name,
    text,
  }));

  if (t.browser) bindings.push({ type: "browser", name: t.browser.binding });
  for (const e of (t.send_email ?? []) as { name: string }[])
    bindings.push({ type: "send_email", name: e.name });
  if (t.assets) bindings.push({ type: "assets", name: t.assets.binding });
  for (const e of (t.d1_databases ?? []) as { binding: string }[])
    bindings.push({ type: "d1", name: e.binding, id: r.d1Id });
  for (const e of (t.r2_buckets ?? []) as { binding: string }[])
    bindings.push({ type: "r2_bucket", name: e.binding, bucket_name: n.r2 });
  for (const e of (t.kv_namespaces ?? []) as { binding: string }[])
    bindings.push({
      type: "kv_namespace",
      name: e.binding,
      namespace_id: r.kvId,
    });
  for (const e of (t.durable_objects?.bindings ?? []) as {
    name: string;
    class_name: string;
  }[])
    bindings.push({
      type: "durable_object_namespace",
      name: e.name,
      class_name: e.class_name,
    });

  const rls = (t.ratelimits ?? []) as {
    name: string;
    namespace_id: string;
    simple: { limit: number; period: number };
  }[];
  if (rls.length > 8)
    throw new Error("template has more than 8 ratelimits; rlNs stride is 8");
  for (const e of rls)
    if (Number(e.namespace_id) >= 1_000_000)
      throw new Error(
        `template ratelimit id ${e.namespace_id} must be < 1000000`,
      );
  rls.forEach((e, k) => {
    bindings.push({
      type: "ratelimit",
      name: e.name,
      namespace_id: String(r.rlNs + k),
      simple: e.simple,
    });
  });

  const known: string[] = [
    ...SECRETS,
    ...(i.testHooks ? ["TEST_HOOK_KEY"] : []),
  ];
  const given = r.secrets ?? {};
  for (const k of Object.keys(given))
    if (!known.includes(k))
      throw new Error(`unknown secret ${JSON.stringify(k)}`);
  for (const k of known)
    if (given[k] !== undefined)
      bindings.push({ type: "secret_text", name: k, text: given[k] });

  const meta: UploadMetadata = {
    main_module: r.mainModule,
    compatibility_date: t.compatibility_date,
    compatibility_flags: t.compatibility_flags ?? [],
    bindings,
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 },
    },
    tags: [i.id, `v${r.version}`],
    assets: {
      config: {
        not_found_handling: "single-page-application",
        run_worker_first: true,
      },
    },
  };
  const migrations = migrationsFor(t, r.doMigrationTag);
  if (migrations) meta.migrations = migrations;
  if (known.some((k) => given[k] === undefined))
    meta.keep_bindings = ["secret_text", "secret_key"];
  return meta;
}
