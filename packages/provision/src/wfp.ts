// WfpProvisioner: one isolated install = one Workers for Platforms user Worker
// (or an account script, for tests and the dispatch Worker itself) with its
// own D1, R2, KV and secrets, named by install id and env.
//
// create(), each step idempotent by checking first:
//   pre-flight (no Cloudflare call): names, target, bundle variant, secrets,
//     metadata dry run
//   token check -> platform row (creating, rl_ns) + audit -> D1 -> R2 -> KV
//   -> server migrations -> upload (assets, secret_text bindings, DO tag
//   probe) -> subdomain off (account only) -> broker keypair (flag)
//   -> HOSTS -> /healthz -> owner PAT (0600) -> MCP selftest -> active.
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { newId, newPat } from "@oa/shared";
import type { Bundle } from "./bundle.js";
import { type Cf, CfError, type Target } from "./cf.js";
import {
  KNOWN_SECRETS,
  loadTemplate,
  scriptSubdomainSettings,
  type Template,
  type UploadMetadata,
  userWorkerMetadata,
} from "./metadata.js";
import {
  assertOwnResource,
  type Env,
  ForeignResource,
  hosts,
  isInstallId,
  names,
  newInstallId,
  platformNames,
} from "./names.js";
import {
  canonicalJson,
  type InstallRow,
  inputsHash,
  PlatformDb,
  RL_BASE,
} from "./platform.js";
import type { CreateInput, Install, InstallId } from "./types.js";

/** The dispatch namespace of each env (live M1 target). */
export const NAMESPACES: Record<Env, string> = {
  staging: "oa-staging",
  prod: "oa-prod",
};

// TODO(Backend): confirm this define name in writing (decision 8). Do not add
// a second name; buildBundle sets it "true" only in the redline variant.
export const TEST_HOOKS_DEFINE = "__OA_TEST_HOOKS_ALLOWED__" as const;

export type BundleVariant = "release" | "redline";

export interface HostedBundle extends Bundle {
  variant: BundleVariant;
  defines: { [TEST_HOOKS_DEFINE]: "true" | "false" };
  /** bundleHash() of this bundle, recorded per release. */
  hash: string;
}

export interface WfpCreateInput extends CreateInput {
  bundle: BundleVariant;
}

export interface WfpOptions {
  cf: Cf;
  env: Env;
  target: Target;
  platformDb: { id: string; name: string };
  hostsKv: { id: string; title: string };
  /** BROKER_REGISTRY; required only when brokerEnabled. */
  registryKv?: { id: string; title: string };
  domains: { app: string; content: string };
  /** Fetches a release's bundle of the given variant (R2 in production). */
  bundles: (variant: BundleVariant) => Promise<HostedBundle>;
  patDir: string;
  /** Broker keypair (P2); off until the broker exists. */
  brokerEnabled?: boolean;
  /** For /healthz and the MCP selftest. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  healthTimeoutMs?: number;
  /** Require /healthz to report installId (Task 6b, Backend). */
  requireInstallId?: boolean;
  /** Test seam; defaults to apps/server/wrangler.template.jsonc. */
  template?: Template;
  /** Defaults to apps/server/migrations. */
  serverMigrationsDir?: string;
}

export class ProvisionRefused extends Error {
  override name = "ProvisionRefused";
}

const SECRET_BYTES = 48;
/** Secrets every install gets in its first upload (TEST_HOOK_KEY added on test installs). */
export const CREATE_SECRETS = [
  ...KNOWN_SECRETS,
  "DIRECTORY_TOKEN_KEY",
] as const;
/** Secrets metadata.ts does not know; appended to its bindings here. */
const EXTRA_SECRETS = ["DIRECTORY_TOKEN_KEY"];
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 2_000;
const MAX_ACTIVE_TOKENS = 50;
const TOKEN_LABEL = "provision";
const MAX_TOKEN_DAYS = 30;
const WARN_TOKEN_DAYS = 5;
const DAY = 86_400_000;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const WELCOME_TITLE = "Welcome to Open Artifacts";
const MIGRATION_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** 48 bytes from the CSPRNG, base64url. Generated per install, never derived. */
export function newSecret(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** Decision 13: at least 32 bytes, base64url, distinct from every other secret of the run. */
export function assertSessionSecret(v: string, others: string[]): void {
  if (
    typeof v !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(v) ||
    Buffer.from(v, "base64url").toString("base64url") !== v
  )
    throw new Error("SESSION_SECRET must be base64url");
  if (Buffer.from(v, "base64url").byteLength < 32)
    throw new Error("SESSION_SECRET must be at least 32 bytes");
  if (others.includes(v))
    throw new Error("SESSION_SECRET must be distinct from every other secret");
}

/** Hash of what a bundle uploads; pins the bytes, the variant and the define. */
export function bundleHash(
  b: Pick<
    HostedBundle,
    "variant" | "defines" | "modules" | "mainModule" | "version"
  >,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        variant: b.variant,
        define: b.defines?.[TEST_HOOKS_DEFINE],
        version: b.version,
        mainModule: b.mainModule,
        modules: [...b.modules]
          .sort((x, y) => (x.name < y.name ? -1 : 1))
          .map((m) => ({
            name: m.name,
            type: m.type,
            sha256: createHash("sha256").update(m.bytes).digest("hex"),
          })),
      }),
    )
    .digest("hex");
}

/** The broker registry origin: exactly https://<appHost>. */
export function brokerOrigin(appHost: string): string {
  if (typeof appHost !== "string" || !HOST_RE.test(appHost))
    throw new Error("broker origin needs a lowercase hostname");
  return `https://${appHost}`;
}

export function assertBrokerOrigin(origin: string, appHost: string): void {
  if (origin !== brokerOrigin(appHost))
    throw new Error(
      "broker origin must be exactly https://<appHost> (https, lowercase, no port, path or trailing slash)",
    );
}

/** kid = first 16 chars of base64url(SHA-256(raw 32-byte public key x)). */
export function brokerKid(x: string): string {
  return createHash("sha256")
    .update(Buffer.from(x, "base64url"))
    .digest("base64url")
    .slice(0, 16);
}

interface RegistryEntry {
  installId: string;
  origin: string;
  keys: { kid: string; x: string }[];
  disabled?: boolean;
}

function newBrokerKey(): { kid: string; x: string; pkcs8: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey as KeyObject).export({ format: "jwk" }).x as string;
  const pkcs8 = b64u(
    (privateKey as KeyObject).export({ format: "der", type: "pkcs8" }),
  );
  return { kid: brokerKid(x), x, pkcs8 };
}

/** Writes a 0600 file, refusing to follow a symlink at `path`. */
function writeSecretFile(path: string, text: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

const errCode = (e: unknown) =>
  (e as { code?: string })?.code ?? (e as Error)?.name ?? "error";

export class WfpProvisioner {
  readonly notes: string[] = [];
  private readonly cf: Cf;
  private readonly env: Env;
  private readonly target: Target;
  private readonly platform: PlatformDb;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly http: typeof fetch;
  /** Values this run must never print; scrubbed from every thrown message. */
  private sensitive = new Set<string>();

  constructor(private readonly o: WfpOptions) {
    this.cf = o.cf;
    this.env = o.env;
    this.target = o.target;
    this.now = o.now ?? Date.now;
    this.sleep =
      o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.http = o.fetch ?? fetch;
    this.platform = new PlatformDb(o.cf, o.platformDb, o.env, this.now);
  }

  async create(i: WfpCreateInput): Promise<Install> {
    this.sensitive = new Set(
      typeof i?.ownerEmail === "string" && i.ownerEmail ? [i.ownerEmail] : [],
    );
    try {
      return await this.run(i);
    } catch (e) {
      throw this.scrub(e);
    }
  }

  private scrub(e: unknown): unknown {
    if (!(e instanceof Error)) return new Error("create failed");
    for (const v of this.sensitive) {
      if (!v) continue;
      e.message = e.message.split(v).join("[redacted]");
      if (e.stack) e.stack = e.stack.split(v).join("[redacted]");
    }
    return e;
  }

  // ---------- pre-flight: no Cloudflare call ----------

  private checkOptions(): void {
    const { env, o } = this;
    if (env !== "staging" && env !== "prod") throw new ForeignResource("", env);
    assertOwnResource(o.platformDb.name, env);
    if (o.platformDb.name !== platformNames(env).db)
      throw new ForeignResource(o.platformDb.name, env);
    assertOwnResource(o.hostsKv.title, env);
    if (o.brokerEnabled) {
      if (!o.registryKv)
        throw new ProvisionRefused(
          "brokerEnabled needs the BROKER_REGISTRY KV",
        );
      assertOwnResource(o.registryKv.title, env);
      if (o.registryKv.title !== platformNames(env).registry)
        throw new ForeignResource(o.registryKv.title, env);
    }
    const t = this.target;
    if (t.kind === "namespace") {
      if (t.ns !== NAMESPACES[env])
        throw new ProvisionRefused(
          `namespace ${JSON.stringify(t.ns)} is not the ${env} dispatch namespace (${NAMESPACES[env]})`,
        );
    } else if (t.kind !== "account")
      throw new ProvisionRefused("target must be account or namespace");
  }

  /** Decision 8: which bundle may go where, before anything is fetched. */
  private checkVariant(i: WfpCreateInput): void {
    const hooks = i.testHooks === true;
    const stagingNs =
      this.env === "staging" &&
      this.target.kind === "namespace" &&
      this.target.ns === NAMESPACES.staging;
    if (hooks && this.env === "prod")
      throw new ProvisionRefused("test hooks are not allowed in prod");
    if (i.bundle === "redline") {
      if (!stagingNs || !hooks)
        throw new ProvisionRefused(
          "the redline (hooks-enabled) bundle is only for test-hook installs in the oa-staging namespace",
        );
    } else if (i.bundle === "release") {
      if (hooks)
        throw new ProvisionRefused(
          "a test-hook install needs the redline bundle, not release",
        );
    } else throw new ProvisionRefused("bundle must be release or redline");
  }

  /** The fetched bundle must be the asked variant, with its define, untampered. */
  private checkBundle(i: WfpCreateInput, b: HostedBundle): void {
    const want = i.bundle === "redline" ? "true" : "false";
    if (b?.variant !== i.bundle)
      throw new ProvisionRefused(
        `asked for the ${i.bundle} bundle, got ${String(b?.variant)}`,
      );
    if (b.defines?.[TEST_HOOKS_DEFINE] !== want)
      throw new ProvisionRefused(
        `${i.bundle} bundle must set ${TEST_HOOKS_DEFINE}=${want}`,
      );
    if (bundleHash(b) !== b.hash)
      throw new ProvisionRefused(
        `bundle ${b.version} (${b.variant}) does not match its recorded hash`,
      );
    this.assertHooksAllowed(b, i.testHooks === true);
  }

  /** Belt and braces: a hooks-enabled bundle only reaches a staging test install. */
  private assertHooksAllowed(b: HostedBundle, testHooks: boolean): void {
    if (b.defines[TEST_HOOKS_DEFINE] === "false") return;
    const t = this.target;
    if (
      this.env !== "staging" ||
      t.kind !== "namespace" ||
      t.ns !== NAMESPACES.staging ||
      !testHooks
    )
      throw new ProvisionRefused(
        "refusing to upload a hooks-enabled bundle outside a staging test-hook install",
      );
  }

  private template(): Template {
    return this.o.template ?? loadTemplate();
  }

  private latestTag(): string | null {
    const m = (this.template().migrations ?? []) as { tag: string }[];
    return m.length ? (m[m.length - 1] as { tag: string }).tag : null;
  }

  // ---------- create ----------

  private async run(i: WfpCreateInput): Promise<Install> {
    this.checkOptions();
    if (i.plan !== "paid") throw new ProvisionRefused("plan must be paid");
    const { appHost, contentHost } = hosts(i.slug, this.o.domains);
    if (i.resumeId !== undefined && !isInstallId(i.resumeId))
      throw new ProvisionRefused("resumeId is not an install id");
    this.checkVariant(i);
    const testHooks = i.testHooks === true;
    const vars = i.vars ?? {};
    const bundle = await this.o.bundles(i.bundle);
    this.checkBundle(i, bundle);

    // Secrets for a fresh upload; unused (and dropped) when the script exists.
    const secrets: Record<string, string> = {};
    for (const k of CREATE_SECRETS) secrets[k] = newSecret();
    if (testHooks) secrets.TEST_HOOK_KEY = newSecret();
    for (const v of Object.values(secrets)) this.sensitive.add(v);
    assertSessionSecret(
      secrets.SESSION_SECRET as string,
      Object.entries(secrets)
        .filter(([k]) => k !== "SESSION_SECRET")
        .map(([, v]) => v),
    );
    if (new Set(Object.values(secrets)).size !== Object.keys(secrets).length)
      throw new Error("generated secrets are not distinct");

    // Dry run: template, vars and ratelimit rules fail here, before any call.
    const meta = {
      appHost,
      contentHost,
      ownerEmail: i.ownerEmail,
      vars,
      testHooks,
    };
    this.metadata("iaaaaaaaaaaa", meta, bundle, {
      d1Id: "00000000-0000-4000-8000-000000000000",
      kvId: "0".repeat(32),
      rlNs: RL_BASE[this.env],
      tag: null,
      mode: "create",
      secrets,
      assetsJwt: "dry-run",
    });

    await this.checkToken();

    // ---------- platform row ----------
    const hash = inputsHash({ ownerEmail: i.ownerEmail, vars, testHooks });
    let row = await this.findRow(i);
    if (row) {
      if (row.state === "active")
        throw new ProvisionRefused(
          `slug ${i.slug} already exists as active install ${row.id}`,
        );
      if (row.state !== "creating")
        throw new ProvisionRefused(
          `install ${row.id} is ${row.state}; only a creating install can be resumed`,
        );
      if (row.inputs_hash !== hash)
        throw new ProvisionRefused(
          `install ${row.id}: resume inputs differ from the first run (owner, vars or testHooks); use the original inputs`,
        );
      if (row.app_host !== appHost || row.content_host !== contentHost)
        throw new ProvisionRefused(
          `install ${row.id}: hosts differ from the first run`,
        );
    } else {
      const holders = await this.platform.holdersOf([appHost, contentHost]);
      if (holders.length > 0)
        throw new ProvisionRefused(
          `host or broker origin already taken by install ${holders[0]?.id} (slug ${i.slug})`,
        );
    }
    for (const h of [appHost, contentHost]) {
      const cur = await this.cf.kvGet(this.o.hostsKv.id, h);
      if (cur !== null && cur !== row?.id)
        throw new ProvisionRefused(`host ${h} is already taken by ${cur}`);
    }
    if (!row) {
      const id = newInstallId();
      row = await this.platform.insertCreating({
        id,
        slug: i.slug,
        appHost,
        contentHost,
        ownerEmail: i.ownerEmail,
        testHooks,
        inputsHash: hash,
      });
      await this.platform.audit(id, "create.start", { slug: i.slug });
    } else {
      await this.platform.audit(row.id, "create.resume", { slug: i.slug });
    }
    const id = row.id;
    try {
      return await this.steps(row, i, bundle, secrets, meta);
    } catch (e) {
      if (e instanceof Error && !e.message.startsWith(`install ${id}`))
        e.message = `install ${id}: ${e.message}`;
      throw e;
    }
  }

  private async findRow(i: WfpCreateInput): Promise<InstallRow | undefined> {
    const bySlug = await this.platform.bySlug(i.slug);
    if (i.resumeId === undefined) return bySlug;
    const byId = await this.platform.byId(i.resumeId);
    if (!byId || byId.slug !== i.slug || bySlug?.id !== byId.id)
      throw new ProvisionRefused(
        `resumeId ${i.resumeId} is not the install for slug ${i.slug}`,
      );
    return byId;
  }

  private async checkToken(): Promise<void> {
    const t = await this.cf.tokenVerify();
    const now = this.now();
    if (t?.status !== "active")
      throw new ProvisionRefused("Cloudflare token is not active");
    if (t.not_before && Date.parse(t.not_before) > now)
      throw new ProvisionRefused(
        "Cloudflare token is not valid yet (not_before is in the future)",
      );
    if (!t.expires_on)
      throw new ProvisionRefused(
        `Cloudflare token has no expiry; set expires_on at most ${MAX_TOKEN_DAYS} days out`,
      );
    const exp = Date.parse(t.expires_on);
    if (!Number.isFinite(exp) || exp <= now)
      throw new ProvisionRefused("Cloudflare token has expired");
    if (exp > now + MAX_TOKEN_DAYS * DAY)
      throw new ProvisionRefused(
        `Cloudflare token expires more than ${MAX_TOKEN_DAYS} days out; mint one with a shorter expiry`,
      );
    if (exp <= now + WARN_TOKEN_DAYS * DAY)
      this.notes.push(
        `the Cloudflare token expires within ${WARN_TOKEN_DAYS} days (${t.expires_on})`,
      );
    try {
      await this.cf.scriptsRead();
    } catch (e) {
      if (e instanceof CfError && (e.status === 401 || e.status === 403))
        throw new ProvisionRefused(
          `Cloudflare token lacks Workers Scripts Read on the account (HTTP ${e.status})`,
        );
      throw e;
    }
  }

  private metadata(
    id: InstallId,
    m: {
      appHost: string;
      contentHost: string;
      ownerEmail: string;
      vars: Record<string, string>;
      testHooks: boolean;
    },
    b: HostedBundle,
    r: {
      d1Id: string;
      kvId: string;
      rlNs: number;
      tag: string | null;
      mode: "create" | "update";
      secrets: Record<string, string>;
      assetsJwt: string;
    },
  ): UploadMetadata {
    const known = Object.fromEntries(
      Object.entries(r.secrets).filter(([k]) => !EXTRA_SECRETS.includes(k)),
    );
    const meta = userWorkerMetadata(
      { id, ...m },
      {
        d1Id: r.d1Id,
        kvId: r.kvId,
        version: b.version,
        rlNs: r.rlNs,
        doMigrationTag: r.tag,
        env: this.env,
        target: this.target.kind,
        mode: r.mode,
        secrets: known,
        mainModule: b.mainModule,
        assetsJwt: r.assetsJwt,
        ...(this.o.template ? { template: this.o.template } : {}),
      },
    );
    for (const k of EXTRA_SECRETS) {
      const v = r.secrets[k];
      if (v !== undefined)
        meta.bindings.push({ type: "secret_text", name: k, text: v });
    }
    // An update never drops the secrets already on the script.
    if (r.mode === "update") meta.keep_bindings = ["secret_text", "secret_key"];
    if (
      !m.testHooks &&
      meta.bindings.some(
        (x) => x.name === "TEST_HOOKS" || x.name === "TEST_HOOK_KEY",
      )
    )
      throw new Error("hooks bindings on a non-test install");
    return meta;
  }

  private async steps(
    row: InstallRow,
    i: WfpCreateInput,
    b: HostedBundle,
    fresh: Record<string, string>,
    m: {
      appHost: string;
      contentHost: string;
      ownerEmail: string;
      vars: Record<string, string>;
      testHooks: boolean;
    },
  ): Promise<Install> {
    const { cf, env, target, platform } = this;
    const id = row.id;
    const n = names(id, env);
    const testHooks = m.testHooks;

    // D1, R2, KV
    let d1Id = row.d1_id ?? (await cf.d1Get(n.d1));
    if (!d1Id) {
      assertOwnResource(n.d1, env);
      d1Id = await cf.d1Create(n.d1);
    }
    if (row.d1_id !== d1Id) await platform.update(id, { d1_id: d1Id });
    if (!(await cf.r2Exists(n.r2))) {
      assertOwnResource(n.r2, env);
      await cf.r2Create(n.r2);
    }
    let kvId = row.kv_id ?? (await cf.kvFind(n.kv));
    if (!kvId) {
      assertOwnResource(n.kv, env);
      kvId = await cf.kvCreate(n.kv);
    }
    if (row.kv_id !== kvId) await platform.update(id, { kv_id: kvId });

    await this.migrate(d1Id, n.d1);

    // Upload, only when something is missing or behind.
    const latest = this.latestTag();
    const exists = await cf.scriptExists(target, n.script);
    const required = [
      ...CREATE_SECRETS,
      ...(testHooks ? ["TEST_HOOK_KEY"] : []),
    ];
    let have = exists ? await cf.secretList(target, n.script) : [];
    const missing = required.filter((k) => !have.includes(k));
    const behind = row.version !== b.version || row.do_migration_tag !== latest;
    if (!exists || missing.length > 0 || behind) {
      const send = Object.fromEntries(
        missing.map((k) => [k, fresh[k] as string]),
      );
      if (send.TEST_HOOK_KEY !== undefined) {
        mkdirSync(this.o.patDir, { recursive: true, mode: 0o700 });
        const f = join(this.o.patDir, `${m.appHost}-hook-key`);
        try {
          writeSecretFile(f, `${send.TEST_HOOK_KEY}\n`);
        } catch (e) {
          throw new Error(
            `could not save the test-hook key to ${f} (${errCode(e)})`,
          );
        }
      }
      const upload = async (tag: string | null) => {
        this.assertHooksAllowed(b, testHooks);
        const { jwt } = await cf.assetsUpload(
          target,
          n.script,
          resolve(b.assetsDir),
        );
        const meta = this.metadata(id, m, b, {
          d1Id: d1Id as string,
          kvId: kvId as string,
          rlNs: row.rl_ns,
          tag,
          mode: exists ? "update" : "create",
          secrets: send,
          assetsJwt: jwt,
        });
        assertOwnResource(n.script, env);
        await cf.scriptUpload(target, n.script, meta, b.modules);
      };
      // Decision 5: the settings API never reports the tag; the journal is
      // checked by a probe (a 412 names the live tag and changes nothing).
      const journal = exists ? row.do_migration_tag : null;
      try {
        await upload(journal);
      } catch (e) {
        const live =
          exists && e instanceof CfError && e.status === 412
            ? /expected tag is '([^']*)'/.exec(e.cfMessage)?.[1]
            : undefined;
        if (live === undefined) throw e;
        const tags = (
          (this.template().migrations ?? []) as { tag: string }[]
        ).map((x) => x.tag);
        if (live !== "" && !tags.includes(live))
          throw new Error(
            `live Durable Object migration tag ${live} is not in this release; forward-fix only`,
          );
        this.notes.push(`probe: live migration tag is ${live || "none"}`);
        await upload(live === "" ? null : live);
      }
      await platform.update(id, {
        version: b.version,
        do_migration_tag: latest,
      });
      await platform.audit(id, "create.upload", {
        version: b.version,
        variant: b.variant,
        bundle: b.hash,
      });
      have = [...new Set([...have, ...missing])];
    }
    // Decision 4: workers.dev and previews off, account scripts only (405 on namespace scripts).
    if (target.kind === "account") {
      assertOwnResource(n.script, env);
      await cf.scriptSubdomain(target, n.script, scriptSubdomainSettings());
    }

    if (this.o.brokerEnabled) await this.broker(id, n.script, m.appHost);

    // HOSTS: after the script exists and holds every secret.
    for (const h of [m.appHost, m.contentHost]) {
      const cur = await cf.kvGet(this.o.hostsKv.id, h);
      if (cur === id) continue;
      if (cur !== null)
        throw new ProvisionRefused(`host ${h} is already taken by ${cur}`);
      assertOwnResource(this.o.hostsKv.title, env);
      await cf.kvPut(this.o.hostsKv.id, h, id);
    }

    await this.health(id, m.appHost, b.version);
    const patFile = await this.mintPat(d1Id, n.d1, m.ownerEmail, m.appHost);
    await this.selftest(m.appHost, patFile);

    await platform.update(id, { state: "active" });
    await platform.audit(id, "create.active", { version: b.version });
    return {
      id,
      slug: i.slug,
      appHost: m.appHost,
      contentHost: m.contentHost,
      version: b.version,
      patFile,
    };
  }

  /** apps/server/migrations/*.sql in order, recorded in d1_migrations as wrangler does. */
  private async migrate(d1Id: string, d1Name: string): Promise<void> {
    const dir =
      this.o.serverMigrationsDir ??
      new URL("../../../apps/server/migrations/", import.meta.url).pathname;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    assertOwnResource(d1Name, this.env);
    await this.cf.d1Query(
      d1Id,
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    const r = await this.cf.d1Query(d1Id, "SELECT name FROM d1_migrations");
    const done = new Set((r[0]?.results ?? []).map((x) => String(x.name)));
    for (const f of files) {
      if (done.has(f)) continue;
      if (!MIGRATION_RE.test(f))
        throw new Error(`unexpected migration file name ${f}`);
      const sql = (await readFile(join(dir, f), "utf8")).trimEnd();
      assertOwnResource(d1Name, this.env);
      // One query: the file and its record land together or not at all.
      await this.cf.d1Query(
        d1Id,
        `${sql}${sql.endsWith(";") ? "" : ";"}\nINSERT INTO d1_migrations (name) VALUES ('${f}');`,
      );
    }
  }

  /** P2 v3: add the new key -> upload BROKER_SIGNING_KEY -> journal kid -> drop the old key. */
  private async broker(
    id: InstallId,
    script: string,
    appHost: string,
  ): Promise<void> {
    const reg = this.o.registryKv as { id: string; title: string };
    const origin = brokerOrigin(appHost);
    assertBrokerOrigin(origin, appHost);
    const raw = await this.cf.kvGet(reg.id, id);
    const entry: RegistryEntry | null = raw === null ? null : JSON.parse(raw);
    if (entry && (entry.installId !== id || entry.origin !== origin))
      throw new ProvisionRefused(
        `broker registry entry for ${id} has another origin or id`,
      );
    const row = await this.platform.byId(id);
    const kid = row?.broker_kid ?? null;
    const secrets = await this.cf.secretList(this.target, script);
    const healthy =
      kid !== null &&
      entry !== null &&
      entry.keys.length === 1 &&
      entry.keys[0]?.kid === kid &&
      secrets.includes("BROKER_SIGNING_KEY");
    if (healthy) return;
    const put = async (keys: RegistryEntry["keys"]) => {
      if (keys.length > 2)
        throw new Error("broker registry entry would hold more than 2 keys");
      const value: RegistryEntry = { installId: id, origin, keys };
      if (entry?.disabled) value.disabled = true;
      assertOwnResource(reg.title, this.env);
      await this.cf.kvPut(reg.id, id, JSON.stringify(value));
    };
    let keys = entry?.keys ?? [];
    if (keys.length >= 2)
      keys = [
        keys.find((k) => k.kid === kid) ??
          (keys[keys.length - 1] as RegistryEntry["keys"][0]),
      ];
    const k = newBrokerKey();
    this.sensitive.add(k.pkcs8);
    await put([...keys, { kid: k.kid, x: k.x }]);
    assertOwnResource(script, this.env);
    await this.cf.secretPut(this.target, script, "BROKER_SIGNING_KEY", k.pkcs8);
    await this.platform.update(id, { broker_kid: k.kid });
    await put([{ kid: k.kid, x: k.x }]);
    await this.platform.audit(id, "create.broker", { kid: k.kid });
  }

  private async health(
    id: InstallId,
    appHost: string,
    version: string,
  ): Promise<void> {
    const timeout = this.o.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    const start = this.now();
    let last = "no answer";
    for (;;) {
      try {
        const res = await this.http(`https://${appHost}/healthz`);
        if (res.status !== 200) last = `HTTP ${res.status}`;
        else {
          const j = (await res.json()) as Record<string, unknown>;
          if (j.ok !== true) last = "ok is not true";
          else if (j.plan !== "paid") last = "plan is not paid";
          else if (j.version !== version) last = `version is not ${version}`;
          else if (this.o.requireInstallId && j.installId !== id)
            last = "installId does not match";
          else return;
        }
      } catch (e) {
        last = errCode(e);
      }
      if (this.now() - start >= timeout)
        throw new Error(
          `/healthz on ${appHost} was not healthy within ${Math.round(timeout / 1000)} s (last: ${last}); rerun create to resume`,
        );
      await this.sleep(HEALTH_INTERVAL_MS);
    }
  }

  /** Same statements as scripts/setup owner-token.ts, parameterized; hash only in SQL. */
  private async mintPat(
    d1Id: string,
    d1Name: string,
    email: string,
    appHost: string,
  ): Promise<string> {
    const pat = newPat();
    this.sensitive.add(pat);
    const tokenId = newId();
    const now = this.now();
    const hash = createHash("sha256").update(pat).digest("hex");
    const q = async (sql: string, params: unknown[]) => {
      if (!/^\s*SELECT/i.test(sql)) assertOwnResource(d1Name, this.env);
      return this.cf.d1Query(d1Id, sql, params);
    };
    await q(
      "INSERT INTO users (id, email, name, role, created_at) VALUES (?1, ?2, ?3, 'owner', ?4) ON CONFLICT(email) DO UPDATE SET role = 'owner'",
      [newId(), email, email.split("@")[0] || email, now],
    );
    const ins = await q(
      `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT ?1, id, ?2, ?3, ?4 FROM users WHERE email = ?5 AND (SELECT count(*) FROM tokens WHERE user_id = users.id AND revoked_at IS NULL) < ${MAX_ACTIVE_TOKENS}`,
      [tokenId, TOKEN_LABEL, hash, now, email],
    );
    if (!ins[0]?.meta?.changes)
      throw new ProvisionRefused(
        `the owner already has ${MAX_ACTIVE_TOKENS} active tokens; revoke some, then rerun`,
      );
    const ok = await q(
      "SELECT id FROM tokens WHERE id = ?1 AND revoked_at IS NULL",
      [tokenId],
    );
    if (!ok[0]?.results?.length)
      throw new Error(`token row ${tokenId} missing after the insert; rerun`);
    mkdirSync(this.o.patDir, { recursive: true, mode: 0o700 });
    const file = join(this.o.patDir, `${appHost}-pat-token`);
    try {
      writeSecretFile(file, `${pat}\n`);
    } catch (e) {
      await q("UPDATE tokens SET revoked_at = ?1 WHERE id = ?2", [
        this.now(),
        tokenId,
      ]).catch(() => {});
      throw new Error(
        `could not save the owner token to ${file} (${errCode(e)}); the new token was revoked; fix that and rerun`,
      );
    }
    // Earlier provision tokens (from a failed earlier run) are retired once the new one is saved.
    await q(
      "UPDATE tokens SET revoked_at = ?1 WHERE user_id = (SELECT id FROM users WHERE email = ?2) AND label = ?3 AND revoked_at IS NULL AND id <> ?4",
      [this.now(), email, TOKEN_LABEL, tokenId],
    );
    return file;
  }

  /** As setup's selftest: publish a private Welcome artifact over MCP and read it back. */
  private async selftest(appHost: string, patFile: string): Promise<void> {
    const token = readFileSync(patFile, "utf8").trim();
    const url = `https://${appHost}/mcp`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    let seq = 0;
    const post = async (method: string, params: unknown) => {
      const id = ++seq;
      const res = await this.http(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status}`);
      const text = await res.text();
      const msgs = res.headers.get("content-type")?.includes("event-stream")
        ? text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => JSON.parse(l.slice(5)))
        : [JSON.parse(text)];
      const msg = msgs.find((x: { id?: number }) => x.id === id);
      if (!msg || msg.error)
        throw new Error(`MCP ${method}: ${msg?.error?.code ?? "no response"}`);
      return msg.result;
    };
    await post("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "oa-provision", version: "1" },
    });
    await this.http(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    const { tools } = await post("tools/list", {});
    if (!tools?.some((t: { name: string }) => t.name === "publish_artifact"))
      throw new Error("MCP tools/list has no publish_artifact");
    const content = readFileSync(
      new URL("../../../scripts/setup/welcome.md", import.meta.url),
      "utf8",
    );
    const pub = await post("tools/call", {
      name: "publish_artifact",
      arguments: { title: WELCOME_TITLE, format: "markdown", content },
    });
    const artId = pub?.structuredContent?.id;
    if (pub?.isError || typeof artId !== "string")
      throw new Error("MCP publish_artifact failed");
    const got = await post("tools/call", {
      name: "get_artifact",
      arguments: { id: artId },
    });
    const body = got?.structuredContent?.content ?? got?.content?.[0]?.text;
    if (
      got?.isError ||
      typeof body !== "string" ||
      !body.includes(WELCOME_TITLE)
    )
      throw new Error(
        `MCP get_artifact did not return the welcome artifact ${artId}`,
      );
  }
}
