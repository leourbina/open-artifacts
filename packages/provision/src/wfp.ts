// WfpProvisioner: one isolated install = one Workers for Platforms user Worker
// (or an account script, for tests and the dispatch Worker itself) with its
// own D1, R2, KV and secrets, named by install id and env.
//
// create(), each step idempotent by checking first:
//   pre-flight (no Cloudflare call): prod lock, env, target, domains, owner
//     email, bundle variant, Turnstile inputs, the signed release record and
//     every release file against it, secrets, metadata dry run
//   token check -> resolve platform D1, HOSTS and registry by name
//   -> Turnstile widget (GET, codes on only)
//   -> platform row (creating, rl_ns, hosts, audit; one batch) -> D1 -> R2
//   -> KV (ids resolved by name and checked against the row) -> server
//   migrations (re-read and re-checked) -> upload (modules, assets and
//   template re-read and re-checked; secret_text bindings, DO tag probe)
//   -> subdomain off (account only) -> broker keypair (flag) -> HOSTS
//   -> /healthz -> owner PAT (0600) -> MCP selftest -> active.
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
import { join } from "node:path";
import { newId, newPat } from "@oa/shared";
import { type Cf, CfError, type Module, type Target } from "./cf.js";
import {
  assertSafeMigrations,
  KNOWN_SECRETS,
  parseTemplate,
  scriptSubdomainSettings,
  type Template,
  type UploadMetadata,
  userWorkerMetadata,
} from "./metadata.js";
import {
  assertOwnResource,
  ENV_PREFIX,
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
import {
  assertAssetPath,
  assetEntries,
  type BundleVariant,
  bundleSha256,
  MIGRATION_RE,
  migrationsSha256,
  RELEASE_PUBKEY,
  RELEASE_PUBKEY_PLACEHOLDER,
  type ReleaseAsset,
  type ReleaseAssetEntry,
  type ReleaseFile,
  type ReleaseReader,
  type ReleaseRecord,
  sha256Hex,
  TEST_HOOKS_DEFINE,
  verifyReleaseSignature,
} from "./release.js";
import type { CreateInput, Install, InstallId } from "./types.js";

/** The dispatch namespace of each env (live M1 target). */
export const NAMESPACES: Record<Env, string> = {
  staging: "oa-staging",
  prod: "oa-prod",
};

/** The tenant domain pair of each env (user decision, 2026-10-21). */
export const HOSTED_DOMAINS: Record<Env, { app: string; content: string }> = {
  staging: {
    app: "open-artifacts-staging.app",
    content: "open-artifacts-staging.page",
  },
  prod: { app: "open-artifacts.app", content: "open-artifacts.page" },
};

/** The platform HOSTS KV namespace title (host -> install id). */
export const hostsKvTitle = (env: Env): string => `${ENV_PREFIX[env]}hosts`;

export interface WfpCreateInput extends CreateInput {
  bundle: BundleVariant;
  version: string;
}

export interface WfpOptions {
  cf: Cf;
  env: Env;
  /** Live envs use { kind: "namespace", ns: NAMESPACES[env] }. */
  target: Target;
  /** Must equal HOSTED_DOMAINS[env]. */
  domains: { app: string; content: string };
  /** The release's signed record and files (R2 in production); never the checkout. */
  release: ReleaseReader;
  /**
   * Prod stays locked until the T3b record writer exists. T3b flips this in
   * code; no CLI flag sets it.
   */
  prodRecordWriter?: "t3b";
  /** Tests only: allow { kind: "account" } (live envs use the namespace). */
  __testOnlyAllowAccountTarget?: true;
  /** Tests only: the release public key instead of RELEASE_PUBKEY[env]. */
  __testOnlyReleasePubkey?: string;
  /**
   * The env's one Turnstile widget (sitekey and secret from the keychain item
   * oa-hosted-<env>-turnstile). Required when codes are on.
   */
  turnstile?: { sitekey: string; secret: string };
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
}

export class ProvisionRefused extends Error {
  override name = "ProvisionRefused";
}

/** Prod creates are refused until the T3b release-record writer exists. */
export class ProdLocked extends ProvisionRefused {
  override name = "ProdLocked";
}

/** As the server: codes are on with AUTH_PROVIDERS containing email, or EMAIL_CODE_DOMAIN=on. */
export function codesOn(vars: Record<string, string>): boolean {
  const providers = (vars.AUTH_PROVIDERS ?? "").split(",").map((p) => p.trim());
  return providers.includes("email") || vars.EMAIL_CODE_DOMAIN === "on";
}

/** The release, read and checked against its signed record. */
interface Checked {
  rec: ReleaseRecord;
  mainModule: string;
  modules: Module[];
  assets: ReleaseAsset[];
  template: Template;
  migrations: ReleaseFile[];
}

const SECRET_BYTES = 48;
/** Secrets every install gets in its first upload (TEST_HOOK_KEY added on test installs). */
export const CREATE_SECRETS = [
  ...KNOWN_SECRETS,
  "DIRECTORY_TOKEN_KEY",
] as const;
/** Secrets metadata.ts does not know; appended to its bindings here. */
const EXTRA_SECRETS = ["DIRECTORY_TOKEN_KEY", "TURNSTILE_SECRET"];
const SITEKEY_RE = /^[0-9A-Za-z_-]{8,64}$/;
/** An old_tag no script can have: the 412 it draws names the live tag. */
const PROBE_TAG = "__oa_probe__";
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 2_000;
const MAX_ACTIVE_TOKENS = 50;
const TOKEN_LABEL = "provision";
const MAX_TOKEN_DAYS = 30;
const WARN_TOKEN_DAYS = 5;
const DAY = 86_400_000;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const ASCII_EMAIL = /^[!-?A-~]+@[!-?A-~]+$/;
const WELCOME_TITLE = "Welcome to Open Artifacts";
const HEX64 = /^[0-9a-f]{64}$/;

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** As the server's normEmail: trimmed, lowercased printable ASCII, or null. */
export function normOwnerEmail(s: string): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length > 320 || !ASCII_EMAIL.test(t)) return null;
  const e = t.toLowerCase();
  return ASCII_EMAIL.test(e) ? e : null;
}

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

/** One record assets entry: a safe path, a size and a full sha256. */
function assertAssetEntry(a: unknown): asserts a is ReleaseAssetEntry {
  const x = a as ReleaseAssetEntry;
  assertAssetPath(x?.path);
  if (!Number.isSafeInteger(x.size) || x.size < 0)
    throw new Error(`asset ${x.path} has no valid size`);
  if (typeof x.sha256 !== "string" || !HEX64.test(x.sha256))
    throw new Error(`asset ${x.path} has no valid sha256`);
}

const errCode = (e: unknown) =>
  (e as { code?: string })?.code ?? (e as Error)?.name ?? "error";

type Meta = {
  appHost: string;
  contentHost: string;
  ownerEmail: string;
  vars: Record<string, string>;
  testHooks: boolean;
  /** The verified Turnstile sitekey when codes are on. */
  sitekey: string | null;
};

export class WfpProvisioner {
  readonly notes: string[] = [];
  private readonly cf: Cf;
  private readonly env: Env;
  private readonly target: Target;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly http: typeof fetch;
  /** Values this run must never print; scrubbed from every thrown error. */
  private sensitive = new Set<string>();
  // Resolved by name per run (never taken from the caller).
  private platform!: PlatformDb;
  private hostsKv!: { id: string; title: string };
  private registryKv?: { id: string; title: string };

  constructor(private readonly o: WfpOptions) {
    this.cf = o.cf;
    this.env = o.env;
    this.target = o.target;
    this.now = o.now ?? Date.now;
    this.sleep =
      o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.http = o.fetch ?? fetch;
  }

  async create(i: WfpCreateInput): Promise<Install> {
    this.sensitive = new Set();
    if (typeof i?.ownerEmail === "string" && i.ownerEmail) {
      this.sensitive.add(i.ownerEmail);
      this.sensitive.add(i.ownerEmail.trim());
      this.sensitive.add(i.ownerEmail.trim().toLowerCase());
    }
    try {
      return await this.run(i);
    } catch (e) {
      throw this.scrub(e);
    }
  }

  /** Scrubs every own string property (message, stack, Cloudflare text, route). */
  private scrub(e: unknown): unknown {
    if (!(e instanceof Error)) return new Error("create failed");
    const rec = e as unknown as Record<string, unknown>;
    for (const k of new Set([
      ...Object.getOwnPropertyNames(e),
      "message",
      "stack",
    ])) {
      let v = rec[k];
      if (typeof v !== "string") continue;
      for (const s of this.sensitive)
        if (s) v = (v as string).split(s).join("[redacted]");
      try {
        rec[k] = v;
      } catch {
        // read-only property: leave it
      }
    }
    return e;
  }

  // ---------- pre-flight: no Cloudflare call ----------

  private checkOptions(): void {
    const { env, o } = this;
    if (env !== "staging" && env !== "prod") throw new ForeignResource("", env);
    // L2: no prod create before the T3b record writer (a code change).
    if (env === "prod" && o.prodRecordWriter !== "t3b")
      throw new ProdLocked(
        "prod is locked until the T3b release-record writer exists",
      );
    const t = this.target;
    if (t.kind === "namespace") {
      if (t.ns !== NAMESPACES[env])
        throw new ProvisionRefused(
          `namespace ${JSON.stringify(t.ns)} is not the ${env} dispatch namespace (${NAMESPACES[env]})`,
        );
    } else if (t.kind === "account") {
      // L3: live envs always use the namespace.
      if (o.__testOnlyAllowAccountTarget !== true)
        throw new ProvisionRefused(
          "the account target is for tests only; live envs use the dispatch namespace",
        );
    } else throw new ProvisionRefused("target must be account or namespace");
    if (this.pubkey() === RELEASE_PUBKEY_PLACEHOLDER)
      throw new ProvisionRefused(
        `RELEASE_PUBKEY.${env} is still the placeholder; T3b must set the release signing key before any create`,
      );
    const d = HOSTED_DOMAINS[env];
    if (o.domains?.app !== d.app || o.domains?.content !== d.content)
      throw new ProvisionRefused(
        `domains must be the ${env} pair (${d.app}, ${d.content})`,
      );
  }

  /** Decision 8 and TEST_DOMAIN: which bundle and vars may go where. */
  private checkVariant(i: WfpCreateInput, vars: Record<string, string>): void {
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
    if (vars.TEST_DOMAIN !== undefined && (!hooks || this.env === "prod"))
      throw new ProvisionRefused(
        "TEST_DOMAIN is only allowed on test-hook installs outside prod",
      );
    if (hooks && typeof vars.TEST_DOMAIN !== "string")
      throw new ProvisionRefused(
        "a test-hook install needs vars.TEST_DOMAIN (hooks act only on emails @TEST_DOMAIN)",
      );
  }

  private pubkey(): string {
    return this.o.__testOnlyReleasePubkey ?? RELEASE_PUBKEY[this.env];
  }

  /** L2 then M1: the record is trusted only after its signature checks out. */
  private async readRecord(i: WfpCreateInput): Promise<ReleaseRecord> {
    const want = `${i.version} (${i.bundle})`;
    const signed = await this.o.release.record(i.version, i.bundle);
    if (!signed)
      throw new ProvisionRefused(
        `no release record for ${want}; the bundle step (T3b) must write one before any create`,
      );
    if (!verifyReleaseSignature(signed, this.pubkey()))
      throw new ProvisionRefused(
        `release record ${want}: the signature is missing or does not verify against the ${this.env} release key`,
      );
    const rec = signed.record;
    if (rec.version !== i.version || rec.variant !== i.bundle)
      throw new ProvisionRefused(
        `the release record read for ${want} is for ${String(rec.version)} (${String(rec.variant)})`,
      );
    const d = rec.defines?.[TEST_HOOKS_DEFINE];
    if (typeof d !== "boolean")
      throw new ProvisionRefused(
        `release record ${want}: ${TEST_HOOKS_DEFINE} must be a boolean literal`,
      );
    if (d !== (i.bundle === "redline"))
      throw new ProvisionRefused(
        `release record ${want}: ${TEST_HOOKS_DEFINE} must be ${i.bundle === "redline"}`,
      );
    for (const k of ["sha256", "templateSha256", "migrationsSha256"] as const)
      if (typeof rec[k] !== "string" || !HEX64.test(rec[k]))
        throw new ProvisionRefused(`release record ${want} has no valid ${k}`);
    if (!Array.isArray(rec.assets))
      throw new ProvisionRefused(`release record ${want} has no assets list`);
    try {
      let prev = "";
      for (const [n, a] of rec.assets.entries()) {
        assertAssetEntry(a);
        if (n > 0 && !(a.path > prev))
          throw new Error("assets are not sorted by path, or repeat one");
        prev = a.path;
      }
    } catch (e) {
      throw new ProvisionRefused(
        `release record ${want}: ${(e as Error).message}`,
      );
    }
    return rec;
  }

  /** M1: each read is checked against the record right before it is used. */
  private refuse(rec: ReleaseRecord, what: string, why?: string): never {
    throw new ProvisionRefused(
      `release ${rec.version} (${rec.variant}): the ${what} do not match the signed record${why ? ` (${why})` : ""}`,
    );
  }

  private async readModules(
    rec: ReleaseRecord,
  ): Promise<{ mainModule: string; modules: Module[] }> {
    const m = await this.o.release.modules(rec.version, rec.variant);
    // A private copy: the bytes hashed are the bytes uploaded.
    const copy = {
      mainModule: String(m?.mainModule),
      modules: (m?.modules ?? []).map((x) => ({
        name: x.name,
        type: x.type,
        bytes: new Uint8Array(x.bytes),
      })),
    };
    if (bundleSha256(copy) !== rec.sha256) this.refuse(rec, "modules");
    return copy;
  }

  private async readAssets(rec: ReleaseRecord): Promise<ReleaseAsset[]> {
    const list = await this.o.release.assets(rec.version, rec.variant);
    const copy = (list ?? []).map((a) => ({
      path: a?.path,
      bytes: new Uint8Array(a?.bytes ?? []),
    }));
    let got: ReturnType<typeof assetEntries>;
    try {
      got = assetEntries(copy);
    } catch (e) {
      throw new ProvisionRefused(
        `release ${rec.version} (${rec.variant}): ${(e as Error).message}`,
      );
    }
    if (canonicalJson(got) !== canonicalJson(rec.assets))
      this.refuse(rec, "assets", "an extra, missing or changed file");
    return copy;
  }

  private async readTemplate(rec: ReleaseRecord): Promise<Template> {
    const bytes = new Uint8Array(
      (await this.o.release.template(rec.version, rec.variant)) ?? [],
    );
    if (sha256Hex(bytes) !== rec.templateSha256) this.refuse(rec, "template");
    const t = parseTemplate(new TextDecoder().decode(bytes));
    // L5: only additive Durable Object migrations, before any call.
    try {
      assertSafeMigrations(t);
    } catch (e) {
      throw new ProvisionRefused((e as Error).message);
    }
    return t;
  }

  private async readMigrations(rec: ReleaseRecord): Promise<ReleaseFile[]> {
    const list = await this.o.release.migrations(rec.version, rec.variant);
    const copy = (list ?? []).map((f) => ({
      name: f?.name,
      bytes: new Uint8Array(f?.bytes ?? []),
    }));
    let h: string;
    try {
      h = migrationsSha256(copy);
    } catch (e) {
      throw new ProvisionRefused(
        `release ${rec.version} (${rec.variant}): ${(e as Error).message}`,
      );
    }
    if (h !== rec.migrationsSha256) this.refuse(rec, "migrations");
    return copy.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Pre-flight: the signed record, then every release file against it. */
  private async readRelease(i: WfpCreateInput): Promise<Checked> {
    if (!this.o.release) throw new ProvisionRefused("no release reader");
    const rec = await this.readRecord(i);
    const { mainModule, modules } = await this.readModules(rec);
    const assets = await this.readAssets(rec);
    const template = await this.readTemplate(rec);
    const migrations = await this.readMigrations(rec);
    return { rec, mainModule, modules, assets, template, migrations };
  }

  /** Belt and braces before every upload: hooks only reach a staging test install. */
  private assertHooksAllowed(variant: BundleVariant, testHooks: boolean): void {
    if (variant === "release") return;
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

  /** Codes on needs the env's Turnstile sitekey and secret; checked before any call. */
  private turnstileInput(
    vars: Record<string, string>,
  ): { sitekey: string; secret: string } | null {
    if (!codesOn(vars)) return null;
    const ts = this.o.turnstile;
    if (
      !ts ||
      typeof ts.sitekey !== "string" ||
      typeof ts.secret !== "string" ||
      ts.sitekey.trim() === "" ||
      ts.secret.trim() === ""
    )
      throw new ProvisionRefused(
        `codes are on (AUTH_PROVIDERS has email, or EMAIL_CODE_DOMAIN=on) but the ${this.env} Turnstile sitekey and secret are missing; run the Turnstile init for ${this.env} first`,
      );
    if (!SITEKEY_RE.test(ts.sitekey))
      throw new ProvisionRefused("the Turnstile sitekey is malformed");
    this.sensitive.add(ts.secret);
    return { sitekey: ts.sitekey, secret: ts.secret };
  }

  /** Read-only: the widget is the env's one, with exactly the env's app domain. */
  private async checkWidget(sitekey: string): Promise<void> {
    const name = platformNames(this.env).turnstile;
    const domain = HOSTED_DOMAINS[this.env].app;
    const w = await this.cf.turnstileWidget(sitekey);
    if (!w || w.sitekey !== sitekey)
      throw new ProvisionRefused(
        `Turnstile widget ${sitekey} not found on the account`,
      );
    if (w.name !== name)
      throw new ProvisionRefused(
        `Turnstile widget ${sitekey} is not ${name} (the ${this.env} widget)`,
      );
    if (
      !Array.isArray(w.domains) ||
      w.domains.length !== 1 ||
      w.domains[0] !== domain
    )
      throw new ProvisionRefused(
        `Turnstile widget ${sitekey} must list exactly [${domain}]`,
      );
  }

  // ---------- create ----------

  private async run(i: WfpCreateInput): Promise<Install> {
    this.checkOptions();
    if (i.plan !== "paid") throw new ProvisionRefused("plan must be paid");
    const ownerEmail = normOwnerEmail(i.ownerEmail);
    if (!ownerEmail)
      throw new ProvisionRefused("ownerEmail is not a valid email");
    const { appHost, contentHost } = hosts(i.slug, this.o.domains);
    if (i.resumeId !== undefined && !isInstallId(i.resumeId))
      throw new ProvisionRefused("resumeId is not an install id");
    const testHooks = i.testHooks === true;
    const vars = i.vars ?? {};
    this.checkVariant(i, vars);
    const ts = this.turnstileInput(vars);
    const rel = await this.readRelease(i);

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
    // Not generated: the env's widget secret, sent like the others.
    if (ts) secrets.TURNSTILE_SECRET = ts.secret;

    // Dry run: template, vars and ratelimit rules fail here, before any call.
    const meta: Meta = {
      appHost,
      contentHost,
      ownerEmail,
      vars,
      testHooks,
      sitekey: ts?.sitekey ?? null,
    };
    this.metadata("iaaaaaaaaaaa", meta, rel, {
      d1Id: "00000000-0000-4000-8000-000000000000",
      kvId: "0".repeat(32),
      rlNs: RL_BASE[this.env],
      tag: null,
      mode: "create",
      secrets,
      assetsJwt: "dry-run",
    });

    await this.checkToken();
    await this.resolvePlatform();
    if (ts) await this.checkWidget(ts.sitekey);

    // ---------- platform row ----------
    const hash = inputsHash({ ownerEmail, vars, testHooks });
    let row = await this.findRow(i);
    let res: { d1: string | null; kv: string | null } | undefined;
    if (row) {
      if (row.state === "active")
        throw new ProvisionRefused(
          `slug ${i.slug} already exists as active install ${row.id}`,
        );
      // Covers deleted too: its slug and hosts stay held until a purge.
      if (row.state !== "creating")
        throw new ProvisionRefused(
          `install ${row.id} is ${row.state}; only a creating install can be resumed (a deleted install keeps its slug and hosts until a purge)`,
        );
      if (row.inputs_hash !== hash)
        throw new ProvisionRefused(
          `install ${row.id}: resume inputs differ from the first run (owner, vars or testHooks); use the original inputs`,
        );
      if (row.app_host !== appHost || row.content_host !== contentHost)
        throw new ProvisionRefused(
          `install ${row.id}: hosts differ from the first run`,
        );
      const held = await this.platform.hostsHeldByOthers(row.id, [
        appHost,
        contentHost,
      ]);
      if (held.length > 0)
        throw new ProvisionRefused(
          `host ${held[0]?.host} is already taken by ${held[0]?.install_id}`,
        );
      res = await this.resources(row);
    } else {
      const holders = await this.platform.holdersOf([appHost, contentHost]);
      if (holders.length > 0)
        throw new ProvisionRefused(
          `host or broker origin already taken by install ${holders[0]?.id} (slug ${i.slug})`,
        );
    }
    for (const h of [appHost, contentHost]) {
      const cur = await this.cf.kvGet(this.hostsKv.id, h);
      if (cur !== null && cur !== row?.id)
        throw new ProvisionRefused(`host ${h} is already taken by ${cur}`);
    }
    if (!row) {
      row = await this.platform.insertCreating({
        id: newInstallId(),
        slug: i.slug,
        appHost,
        contentHost,
        ownerEmail,
        testHooks,
        inputsHash: hash,
      });
    } else {
      await this.platform.resume({
        id: row.id,
        slug: i.slug,
        appHost,
        contentHost,
      });
    }
    const id = row.id;
    try {
      return await this.steps(row, res, i, rel, secrets, meta);
    } catch (e) {
      if (e instanceof Error && !e.message.startsWith(`install ${id}`))
        e.message = `install ${id}: ${e.message}`;
      throw e;
    }
  }

  /** H1: the platform D1, HOSTS and registry come from env names, never from ids handed in. */
  private async resolvePlatform(): Promise<void> {
    const env = this.env;
    const dbName = platformNames(env).db;
    const dbId = await this.cf.d1Get(dbName);
    if (!dbId) throw new ProvisionRefused(`platform D1 ${dbName} not found`);
    this.platform = new PlatformDb(
      this.cf,
      { id: dbId, name: dbName },
      env,
      this.now,
    );
    const hostsTitle = hostsKvTitle(env);
    const hostsId = await this.cf.kvFind(hostsTitle);
    if (!hostsId)
      throw new ProvisionRefused(`HOSTS KV ${hostsTitle} not found`);
    this.hostsKv = { id: hostsId, title: hostsTitle };
    if (this.o.brokerEnabled) {
      const regTitle = platformNames(env).registry;
      const regId = await this.cf.kvFind(regTitle);
      if (!regId)
        throw new ProvisionRefused(`broker registry KV ${regTitle} not found`);
      this.registryKv = { id: regId, title: regTitle };
    }
  }

  /** H1: an install's D1 and KV are resolved by name; a row id that disagrees is refused. */
  private async resources(
    row: InstallRow,
  ): Promise<{ d1: string | null; kv: string | null }> {
    const n = names(row.id, this.env);
    const d1 = await this.cf.d1Get(n.d1);
    if (row.d1_id !== null && row.d1_id !== d1)
      throw new ProvisionRefused(
        `install ${row.id}: installs.d1_id is not the id of D1 ${n.d1}; refusing to touch another database`,
      );
    const kv = await this.cf.kvFind(n.kv);
    if (row.kv_id !== null && row.kv_id !== kv)
      throw new ProvisionRefused(
        `install ${row.id}: installs.kv_id is not the id of KV ${n.kv}; refusing to touch another namespace`,
      );
    return { d1, kv };
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
    m: Meta,
    b: { rec: ReleaseRecord; mainModule: string; template: Template },
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
    const { sitekey, ...install } = m;
    const meta = userWorkerMetadata(
      { id, ...install },
      {
        d1Id: r.d1Id,
        kvId: r.kvId,
        version: b.rec.version,
        rlNs: r.rlNs,
        doMigrationTag: r.tag,
        env: this.env,
        target: this.target.kind,
        mode: r.mode,
        secrets: known,
        mainModule: b.mainModule,
        assetsJwt: r.assetsJwt,
        template: b.template,
      },
    );
    if (sitekey !== null)
      meta.bindings.push({
        type: "plain_text",
        name: "TURNSTILE_SITE_KEY",
        text: sitekey,
      });
    for (const k of EXTRA_SECRETS) {
      const v = r.secrets[k];
      if (v !== undefined)
        meta.bindings.push({ type: "secret_text", name: k, text: v });
    }
    // An update never drops the secrets already on the script.
    if (r.mode === "update") meta.keep_bindings = ["secret_text", "secret_key"];
    if (
      !m.testHooks &&
      meta.bindings.some((x) =>
        ["TEST_HOOKS", "TEST_HOOK_KEY", "TEST_DOMAIN"].includes(x.name),
      )
    )
      throw new Error("hooks bindings on a non-test install");
    return meta;
  }

  private async steps(
    row: InstallRow,
    resolved: { d1: string | null; kv: string | null } | undefined,
    i: WfpCreateInput,
    rel: Checked,
    fresh: Record<string, string>,
    m: Meta,
  ): Promise<Install> {
    const { cf, env, target, platform } = this;
    const rec = rel.rec;
    const version = rec.version;
    const id = row.id;
    const n = names(id, env);
    const testHooks = m.testHooks;
    const res = resolved ?? (await this.resources(row));

    // D1, R2, KV (ids resolved by name, checked against the row)
    let d1Id = res.d1;
    if (!d1Id) {
      assertOwnResource(n.d1, env);
      d1Id = await cf.d1Create(n.d1);
    }
    if (row.d1_id !== d1Id) await platform.update(id, { d1_id: d1Id });
    if (!(await cf.r2Exists(n.r2))) {
      assertOwnResource(n.r2, env);
      await cf.r2Create(n.r2);
    }
    let kvId = res.kv;
    if (!kvId) {
      assertOwnResource(n.kv, env);
      kvId = await cf.kvCreate(n.kv);
    }
    if (row.kv_id !== kvId) await platform.update(id, { kv_id: kvId });

    await this.migrate(rec, d1Id, n.d1);

    // Upload, only when something is missing or behind.
    const tags = ((rel.template.migrations ?? []) as { tag: string }[]).map(
      (x) => x.tag,
    );
    const latest = tags.length ? (tags[tags.length - 1] as string) : null;
    const exists = await cf.scriptExists(target, n.script);
    const required = [
      ...CREATE_SECRETS,
      ...(testHooks ? ["TEST_HOOK_KEY"] : []),
      ...(m.sitekey !== null ? ["TURNSTILE_SECRET"] : []),
    ];
    const have = exists ? await cf.secretList(target, n.script) : [];
    const missing = required.filter((k) => !have.includes(k));
    const behind = row.version !== version || row.do_migration_tag !== latest;
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
      const upload = async (tag: string | null, probe = false) => {
        this.assertHooksAllowed(rec.variant, testHooks);
        // M1: re-read from the release and re-check right before the write;
        // what is uploaded is exactly what was just checked.
        const mods = await this.readModules(rec);
        const assets = await this.readAssets(rec);
        const template = await this.readTemplate(rec);
        const { jwt } = await cf.assetsUpload(target, n.script, assets);
        const meta = this.metadata(
          id,
          m,
          { rec, mainModule: mods.mainModule, template },
          {
            d1Id: d1Id as string,
            kvId: kvId as string,
            rlNs: row.rl_ns,
            tag,
            mode: exists ? "update" : "create",
            secrets: send,
            assetsJwt: jwt,
          },
        );
        if (probe && meta.migrations) meta.migrations.old_tag = PROBE_TAG;
        assertOwnResource(n.script, env);
        await cf.scriptUpload(target, n.script, meta, mods.modules);
      };
      // Decision 5: the settings API never reports the tag. The journal is
      // checked by uploading: a 412 names the live tag and changes nothing.
      // An existing script with an empty journal is probed with a tag it
      // cannot have; a missing script is never probed.
      const journal = exists ? row.do_migration_tag : null;
      try {
        await upload(journal, exists && journal === null);
      } catch (e) {
        const live =
          exists && e instanceof CfError && e.status === 412
            ? /expected tag is '([^']*)'/.exec(e.cfMessage)?.[1]
            : undefined;
        if (live === undefined) throw e;
        if (live !== "" && !tags.includes(live))
          throw new Error(
            `live Durable Object migration tag ${live} is not in this release; forward-fix only`,
          );
        this.notes.push(`probe: live migration tag is ${live || "none"}`);
        await upload(live === "" ? null : live);
      }
      await platform.update(id, {
        version,
        do_migration_tag: latest,
      });
      await platform.audit(id, "create.upload", {
        version,
        variant: rec.variant,
        sha256: rec.sha256,
      });
    }
    // Decision 4: workers.dev and previews off, account scripts only (405 on namespace scripts).
    if (target.kind === "account") {
      assertOwnResource(n.script, env);
      await cf.scriptSubdomain(target, n.script, scriptSubdomainSettings());
    }

    if (this.o.brokerEnabled) await this.broker(id, n.script, m.appHost);

    // HOSTS: after the script exists and holds every secret.
    for (const h of [m.appHost, m.contentHost]) {
      const cur = await cf.kvGet(this.hostsKv.id, h);
      if (cur === id) continue;
      if (cur !== null)
        throw new ProvisionRefused(`host ${h} is already taken by ${cur}`);
      assertOwnResource(this.hostsKv.title, env);
      await cf.kvPut(this.hostsKv.id, h, id);
    }

    await this.health(id, m.appHost, version);
    const patFile = await this.mintPat(d1Id, n.d1, m.ownerEmail, m.appHost);
    await this.selftest(m.appHost, patFile);

    await platform.update(id, { state: "active" });
    await platform.audit(id, "create.active", { version });
    return {
      id,
      slug: i.slug,
      appHost: m.appHost,
      contentHost: m.contentHost,
      version,
      patFile,
    };
  }

  /** The release's D1 migrations in order, recorded in d1_migrations as wrangler does. */
  private async migrate(
    rec: ReleaseRecord,
    d1Id: string,
    d1Name: string,
  ): Promise<void> {
    // M1: re-read from the release and re-check right before applying.
    const files = await this.readMigrations(rec);
    assertOwnResource(d1Name, this.env);
    await this.cf.d1Query(
      d1Id,
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    const r = await this.cf.d1Query(d1Id, "SELECT name FROM d1_migrations");
    const done = new Set((r[0]?.results ?? []).map((x) => String(x.name)));
    for (const f of files) {
      if (done.has(f.name)) continue;
      if (!MIGRATION_RE.test(f.name))
        throw new Error(`unexpected migration file name ${f.name}`);
      const sql = new TextDecoder().decode(f.bytes).trimEnd();
      assertOwnResource(d1Name, this.env);
      // One query: the file and its record land together or not at all.
      await this.cf.d1Query(
        d1Id,
        `${sql}${sql.endsWith(";") ? "" : ";"}\nINSERT INTO d1_migrations (name) VALUES ('${f.name}');`,
      );
    }
  }

  /** P2 v3: add the new key -> upload BROKER_SIGNING_KEY -> journal kid -> drop the old key. */
  private async broker(
    id: InstallId,
    script: string,
    appHost: string,
  ): Promise<void> {
    const reg = this.registryKv as { id: string; title: string };
    const origin = brokerOrigin(appHost);
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
      assertBrokerOrigin(value.origin, appHost);
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
