import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as Sqlite } from "node:sqlite";
import { isPat } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Bundle } from "../src/bundle.js";
import { assetHash, CfError, cfClient, type Target } from "../src/cf.js";
import {
  HOSTED_ADDED,
  loadTemplate,
  userWorkerMetadata,
} from "../src/metadata.js";
import { ENV_PREFIX, type Env, platformNames } from "../src/names.js";
import { inputsHash } from "../src/platform.js";
import {
  assertBrokerOrigin,
  assertSessionSecret,
  brokerKid,
  brokerOrigin,
  bundleSha256,
  HOSTED_DOMAINS,
  hostsKvTitle,
  NAMESPACES,
  type ReleaseRecord,
  TEST_HOOKS_DEFINE,
  type WfpOptions,
  WfpProvisioner,
} from "../src/wfp.js";
import { type FakeCf as Fake, FakeCf, splitSql } from "./fake-cf.js";

// Every generated secret, PAT and broker private key is captured at the
// generator, so values that were generated and then discarded (resumes,
// rotations, superseded PATs) are scanned too.
const H = vi.hoisted(() => ({ SENSITIVE: new Set<string>() }));
vi.mock("@oa/shared", async (orig) => {
  const m = await orig<typeof import("@oa/shared")>();
  return {
    ...m,
    newPat: () => {
      const v = m.newPat();
      H.SENSITIVE.add(v);
      return v;
    },
  };
});
vi.mock("node:crypto", async (orig) => {
  const m = await orig<typeof import("node:crypto")>();
  // biome-ignore lint/suspicious/noExplicitAny: wraps an overloaded function
  const generateKeyPairSync = (...a: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: overloaded
    const kp = (m.generateKeyPairSync as any)(...a);
    H.SENSITIVE.add(
      kp.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
    );
    return kp;
  };
  return { ...m, default: { ...m, generateKeyPairSync }, generateKeyPairSync };
});
const SENSITIVE = H.SENSITIVE;
beforeAll(() => {
  const real = crypto.getRandomValues.bind(crypto);
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(a: T): T => {
      const r = real(a as unknown as Uint8Array) as unknown as T;
      const v = a as unknown as Uint8Array;
      if (v && v.byteLength === 48)
        SENSITIVE.add(
          Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString(
            "base64url",
          ),
        );
      return r;
    },
  );
});

const NOW = Date.parse("2026-10-22T00:00:00Z");
const ROOT = new URL("../../../", import.meta.url);
const PLATFORM_SQL = readFileSync(
  new URL("apps/platform-db/migrations/0001_installs.sql", ROOT),
  "utf8",
);
const SERVER_MIGRATIONS = readdirSync(new URL("apps/server/migrations/", ROOT))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const OWNER = "owner@finqore.test";
const EMAILS = new Set([OWNER, "someone@else.test"]);
const HOOK_VARS = { TEST_DOMAIN: "redline.test" };

const THROWN: string[] = [];
const PRINTABLE: string[] = [];
const FAKES: Fake[] = [];
const PROVS: WfpProvisioner[] = [];

async function fails(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    THROWN.push(String((e as Error).message), String(e), JSON.stringify(e));
    return e as Error;
  }
  throw new Error("expected a failure");
}

const enc = (s: string) => new TextEncoder().encode(s);

function makeBundle(
  variant: "release" | "redline",
  version = "0.23.0",
): Bundle {
  return {
    modules: [
      {
        name: "index.js",
        type: "esm",
        bytes: enc(
          `const hooksAllowed = ${variant === "redline"};\nexport default { fetch() { return new Response(String(hooksAllowed)); } };\n`,
        ),
      },
    ],
    mainModule: "index.js",
    assetsDir: "",
    version,
  };
}

/** The per-release manifest the bundle step (T3b) will write. */
const recordOf = (
  variant: "release" | "redline",
  version = "0.23.0",
): ReleaseRecord => ({
  version,
  variant,
  sha256: bundleSha256(makeBundle(variant, version)),
  defines: { [TEST_HOOKS_DEFINE]: variant === "redline" },
});

type SetupOpts = {
  env?: Env;
  target?: Target;
  brokerEnabled?: boolean;
  template?: WfpOptions["template"];
  bundles?: WfpOptions["bundles"];
  releaseRecord?: WfpOptions["releaseRecord"];
  seed?: boolean;
};

function setup(o: SetupOpts = {}) {
  const fake = new FakeCf({ now: NOW });
  FAKES.push(fake);
  SENSITIVE.add(fake.token);
  const env = o.env ?? "staging";
  const seed = o.seed ?? true;
  const pdb = seed ? fake.seedD1(platformNames(env).db, PLATFORM_SQL) : "";
  const hostsId = seed ? fake.seedKv(hostsKvTitle(env)) : "";
  const regId = seed ? fake.seedKv(platformNames(env).registry) : "";
  const target: Target = o.target ?? { kind: "namespace", ns: NAMESPACES[env] };
  fake.dispatch = {
    hostsKvId: hostsId,
    ns: target.kind === "namespace" ? target.ns : null,
  };
  const patDir = mkdtempSync(join(tmpdir(), "oa-t4-pat-"));
  const assetsDir = mkdtempSync(join(tmpdir(), "oa-t4-assets-"));
  writeFileSync(join(assetsDir, "index.html"), "<!doctype html><p>hi</p>");
  writeFileSync(join(assetsDir, "app.js"), "console.log(1)");
  let t = NOW;
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  const cf = cfClient({
    accountId: fake.accountId,
    token: fake.token,
    fetch: fake.fetch,
    sleep: async () => {},
  });
  const opts = (over: Partial<WfpOptions> = {}): WfpOptions => ({
    cf,
    env,
    target,
    domains: HOSTED_DOMAINS[env],
    bundles:
      o.bundles ??
      (async (version, v) => ({ ...makeBundle(v, version), assetsDir })),
    releaseRecord:
      o.releaseRecord ?? (async (version, v) => recordOf(v, version)),
    patDir,
    brokerEnabled: o.brokerEnabled ?? false,
    fetch: fake.fetch,
    now: clock.now,
    sleep: clock.sleep,
    ...(o.template ? { template: o.template } : {}),
    ...over,
  });
  const mk = (over: Partial<WfpOptions> = {}) => {
    const p = new WfpProvisioner(opts(over));
    PROVS.push(p);
    return p;
  };
  const db = () => (fake.d1.get(pdb) as { db: DatabaseSync }).db;
  // biome-ignore lint/suspicious/noExplicitAny: test rows
  const rows = () => db().prepare("SELECT * FROM installs").all() as any[];
  const scriptOf = (id: string) =>
    fake.script(
      target.kind === "namespace" ? target.ns : null,
      `${ENV_PREFIX[env]}${id}`,
    );
  return {
    fake,
    env,
    p: mk(),
    mk,
    pdb,
    hostsId,
    regId,
    patDir,
    assetsDir,
    target,
    db,
    rows,
    scriptOf,
    clock,
  };
}

const input = (
  slug = "finqore",
  o: Partial<Parameters<WfpProvisioner["create"]>[0]> = {},
): Parameters<WfpProvisioner["create"]>[0] => ({
  slug,
  ownerEmail: OWNER,
  plan: "paid",
  vars: {},
  bundle: "release",
  version: "0.23.0",
  ...o,
});
const hookInput = (slug = "redqa") =>
  input(slug, { testHooks: true, bundle: "redline", vars: HOOK_VARS });

const nonReads = (fake: Fake, from = 0) => fake.writes().slice(from);

const uploads = (fake: Fake) =>
  fake.log
    .map((e, i) => ({ ...e, body: fake.raw[i]?.body ?? "" }))
    .filter((e) => e.method === "PUT" && /\/scripts\/[^/?]+$/.test(e.path));

function metaOf(body: string) {
  const m = body.match(
    /name="metadata"[^\n]*\r?\n(?:[^\n]*\r?\n)*?\r?\n(\{.*\})\r?\n/,
  );
  if (!m) throw new Error("no metadata part");
  return JSON.parse(m[1] as string);
}

const secretBindings = (meta: { bindings: { type: string; name: string }[] }) =>
  meta.bindings.filter((b) => b.type === "secret_text").map((b) => b.name);

/** Make /healthz unhealthy so a create stops after the upload. */
async function failAtHealth(s: ReturnType<typeof setup>, i = input(), p = s.p) {
  s.fake.health = () => ({ ok: false });
  const e = await fails(p.create(i));
  s.fake.health = undefined;
  return e;
}

const seedRow = (
  s: ReturnType<typeof setup>,
  r: {
    id: string;
    slug: string;
    app: string;
    content: string;
    state: string;
    rlNs?: number;
  },
) => {
  s.db()
    .prepare(
      "INSERT INTO installs (id, slug, app_host, content_host, owner_email, inputs_hash, state, rl_ns, created_at, updated_at) VALUES (?, ?, ?, ?, 'x@y.test', 'x', ?, ?, 1, 1)",
    )
    .run(r.id, r.slug, r.app, r.content, r.state, r.rlNs ?? 1_000_000);
  const h = s
    .db()
    .prepare("INSERT INTO hosts (host, install_id) VALUES (?, ?)");
  h.run(r.app, r.id);
  h.run(r.content, r.id);
};

describe("WfpProvisioner.create", () => {
  it("creates every resource named by install id and maps both hosts", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    PRINTABLE.push(JSON.stringify(inst));
    const [row] = s.rows();
    expect(row).toMatchObject({
      id: inst.id,
      slug: "finqore",
      app_host: "finqore.open-artifacts-staging.app",
      content_host: "finqore.open-artifacts-staging.page",
      state: "active",
      test_hooks: 0,
      version: "0.23.0",
      do_migration_tag: "v1",
    });
    expect(
      s
        .db()
        .prepare("SELECT host FROM hosts WHERE install_id = ? ORDER BY host")
        .all(inst.id)
        .map((r) => (r as { host: string }).host),
    ).toEqual([
      "finqore.open-artifacts-staging.app",
      "finqore.open-artifacts-staging.page",
    ]);
    const n = `oa-s-${inst.id}`;
    expect([...s.fake.d1.values()].filter((d) => d.name === n)).toHaveLength(1);
    expect(row.d1_id).toBe(
      [...s.fake.d1.entries()].find(([, d]) => d.name === n)?.[0],
    );
    expect(s.fake.r2.has(n)).toBe(true);
    expect(row.kv_id).toBe(
      [...s.fake.kv.entries()].find(([, k]) => k.title === `${n}-oauth`)?.[0],
    );
    expect(s.fake.script("oa-staging", n)).toBeDefined();
    expect(s.fake.kvValues(s.hostsId).get(inst.appHost)).toBe(inst.id);
    expect(s.fake.kvValues(s.hostsId).get(inst.contentHost)).toBe(inst.id);
    expect(s.fake.kvValues(s.hostsId).size).toBe(2);
    const idb = s.fake.d1.get(row.d1_id)?.db as DatabaseSync;
    const applied = idb
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(applied).toEqual(SERVER_MIGRATIONS);
    expect(
      idb.prepare("SELECT role FROM users WHERE email = ?").get(OWNER),
    ).toEqual({ role: "owner" });
    expect(s.fake.artifacts.size).toBe(1);
    expect([...s.fake.artifacts.values()][0]?.title).toMatch(/Welcome/);
    const audit = s
      .db()
      .prepare(
        "SELECT action FROM hosted_audit WHERE install_id = ? ORDER BY id",
      )
      .all(inst.id)
      .map((r) => (r as { action: string }).action);
    expect(audit[0]).toBe("create.start");
    expect(audit.at(-1)).toBe("create.active");
    expect(inst).toMatchObject({
      slug: "finqore",
      appHost: "finqore.open-artifacts-staging.app",
      contentHost: "finqore.open-artifacts-staging.page",
      version: "0.23.0",
      patFile: join(s.patDir, "finqore.open-artifacts-staging.app-pat-token"),
    });
  });

  it("namespace target: every script call uses the dispatch route and the subdomain API is never called", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    const scriptCalls = s.fake.log.filter(
      (e) => e.path.includes(`oa-s-${inst.id}`) && e.path.includes("/workers/"),
    );
    expect(scriptCalls.length).toBeGreaterThan(0);
    for (const e of scriptCalls)
      expect(e.path).toContain(
        "/workers/dispatch/namespaces/oa-staging/scripts/",
      );
    expect(s.fake.log.some((e) => e.path.endsWith("/subdomain"))).toBe(false);
    expect(s.fake.log.some((e) => e.status === 405)).toBe(false);
  });

  it("account target: script calls use /workers/scripts and the subdomain API turns workers.dev and previews off", async () => {
    const s = setup({ target: { kind: "account" } });
    const inst = await s.p.create(input());
    const sc = s.fake.script(null, `oa-s-${inst.id}`);
    expect(sc?.subdomain).toEqual({ enabled: false, previews_enabled: false });
    expect(s.fake.log.some((e) => e.path.includes("/dispatch/"))).toBe(false);
    const up = s.fake.log.findIndex(
      (e) =>
        e.method === "PUT" &&
        e.path.endsWith(`/workers/scripts/oa-s-${inst.id}`),
    );
    const sub = s.fake.log.findIndex((e) =>
      e.path.endsWith(`/workers/scripts/oa-s-${inst.id}/subdomain`),
    );
    expect(up).toBeGreaterThanOrEqual(0);
    expect(sub).toBeGreaterThan(up);
  });

  it("account target: every later upload calls the subdomain API again", async () => {
    const s = setup({ target: { kind: "account" } });
    await failAtHealth(s);
    const [row] = s.rows();
    s.scriptOf(row.id)?.secrets.delete("DIRECTORY_TOKEN_KEY");
    await s.p.create(input());
    expect(uploads(s.fake)).toHaveLength(2);
    expect(
      s.fake.log.filter((e) => e.path.endsWith("/subdomain")),
    ).toHaveLength(2);
  });

  it("an upgrade that introduces DIRECTORY_TOKEN_KEY sends only that secret binding, with keep_bindings, and leaves the others untouched", async () => {
    const s = setup();
    await failAtHealth(s);
    const [row] = s.rows();
    const sc = s.scriptOf(row.id);
    if (!sc) throw new Error("no script");
    const before = new Map(sc.secrets);
    sc.secrets.delete("DIRECTORY_TOKEN_KEY");
    await s.p.create(input());
    const ups = uploads(s.fake);
    expect(ups).toHaveLength(2);
    const meta = metaOf(ups[1]?.body as string);
    expect(secretBindings(meta)).toEqual(["DIRECTORY_TOKEN_KEY"]);
    expect(meta.keep_bindings).toEqual(expect.arrayContaining(["secret_text"]));
    const after = s.scriptOf(row.id)?.secrets as Map<string, string>;
    expect(after.get("SESSION_SECRET")).toBe(before.get("SESSION_SECRET"));
    expect(after.get("CONTENT_SIGNING_KEY")).toBe(
      before.get("CONTENT_SIGNING_KEY"),
    );
    expect(after.get("DIRECTORY_TOKEN_KEY")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(after.get("DIRECTORY_TOKEN_KEY")).not.toBe(
      before.get("DIRECTORY_TOKEN_KEY"),
    );
  });

  describe("resume by slug", () => {
    it("a creating row is resumed with the same id", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      expect(row.state).toBe("creating");
      const inst = await s.p.create(input());
      expect(inst.id).toBe(row.id);
      expect(s.rows()).toHaveLength(1);
      expect(s.rows()[0].rl_ns).toBe(row.rl_ns);
    });

    it("resumeId resumes that row; a resumeId of another slug is refused", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input("other", { resumeId: row.id })));
      expect(e.message).toMatch(/resume/);
      expect(nonReads(s.fake, n)).toEqual([]);
      const inst = await s.p.create(input("finqore", { resumeId: row.id }));
      expect(inst.id).toBe(row.id);
    });

    it("an active slug fails before any Cloudflare write", async () => {
      const s = setup();
      await s.p.create(input());
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/already exists|active/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });

    it.each([
      ["owner", { ownerEmail: "someone@else.test" }],
      ["vars", { vars: { EMAIL_DAILY_CAP: "5" } }],
      [
        "testHooks",
        { testHooks: true, bundle: "redline" as const, vars: HOOK_VARS },
      ],
    ])(
      "a resume with a different %s is refused before any Cloudflare write",
      async (_k, over) => {
        const s = setup();
        s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
        await fails(s.p.create(input()));
        const n = s.fake.writes().length;
        const e = await fails(s.p.create(input("finqore", over)));
        expect(e.message).toMatch(/inputs/);
        expect(nonReads(s.fake, n)).toEqual([]);
        expect(s.rows()[0].inputs_hash).toBe(
          inputsHash({ ownerEmail: OWNER, vars: {}, testHooks: false }),
        );
      },
    );

    it("the owner email is normalized (trim, lowercase), so a resume in other casing is the same input", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(
        s.p.create(input("finqore", { ownerEmail: " Owner@FinQore.TEST " })),
      );
      expect(s.rows()[0].owner_email).toBe(OWNER);
      const inst = await s.p.create(input());
      const owner = s
        .scriptOf(inst.id)
        ?.metadata.bindings.find(
          (b: { name: string }) => b.name === "OWNER_EMAIL",
        );
      expect(owner.text).toBe(OWNER);
    });
  });

  describe("resume heals the hosts table (N1)", () => {
    const hostRows = (s: ReturnType<typeof setup>, id: string) =>
      s
        .db()
        .prepare("SELECT host FROM hosts WHERE install_id = ? ORDER BY host")
        .all(id)
        .map((r) => (r as { host: string }).host);

    it("a row without its hosts rows resumes, and both hosts rows end up present", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      s.db().prepare("DELETE FROM hosts WHERE install_id = ?").run(row.id);
      expect(hostRows(s, row.id)).toEqual([]);
      await s.p.create(input());
      expect(hostRows(s, row.id)).toEqual([
        "finqore.open-artifacts-staging.app",
        "finqore.open-artifacts-staging.page",
      ]);
    });

    it("a resume whose host is held by another install in the hosts table is refused before any write", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      seedRow(s, {
        id: "iaaaaaaaaaaa",
        slug: "other",
        app: "other.open-artifacts-staging.app",
        content: "other.open-artifacts-staging.page",
        state: "active",
        rlNs: 1_999_992,
      });
      s.db().prepare("DELETE FROM hosts WHERE install_id = ?").run(row.id);
      s.db()
        .prepare(
          "INSERT INTO hosts (host, install_id) VALUES (?, 'iaaaaaaaaaaa')",
        )
        .run("finqore.open-artifacts-staging.page");
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });
  });

  describe("resources are resolved by name, never trusted from ids (H1)", () => {
    it("a missing staging platform D1 is refused with zero writes, even when the prod one exists", async () => {
      const s = setup({ seed: false });
      s.fake.seedD1(platformNames("prod").db, PLATFORM_SQL);
      s.fake.seedKv(hostsKvTitle("staging"));
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/oa-s-platform/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("a missing staging HOSTS KV is refused with zero writes, even when the prod one exists", async () => {
      const s = setup({ seed: false });
      s.fake.seedD1(platformNames("staging").db, PLATFORM_SQL);
      s.fake.seedKv(hostsKvTitle("prod"));
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/oa-s-hosts/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("a missing staging broker registry is refused with zero writes", async () => {
      const s = setup({ seed: false, brokerEnabled: true });
      s.fake.seedD1(platformNames("staging").db, PLATFORM_SQL);
      s.fake.seedKv(hostsKvTitle("staging"));
      s.fake.seedKv(platformNames("prod").registry);
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/oa-s-broker-registry/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("a staging create only ever touches the staging platform ids", async () => {
      const s = setup({ brokerEnabled: true });
      const prodDb = s.fake.seedD1(platformNames("prod").db, PLATFORM_SQL);
      const prodHosts = s.fake.seedKv(hostsKvTitle("prod"));
      const prodReg = s.fake.seedKv(platformNames("prod").registry);
      await s.p.create(input());
      for (const id of [prodDb, prodHosts, prodReg])
        expect(s.fake.log.some((e) => e.path.includes(id))).toBe(false);
    });

    it("a row whose d1_id belongs to another install is refused before any write", async () => {
      const s = setup();
      const a = await s.p.create(input("alpha"));
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input("beta")));
      const beta = s.rows().find((r) => r.slug === "beta");
      const alpha = s.rows().find((r) => r.id === a.id);
      expect(beta.d1_id).toBeTruthy();
      s.db()
        .prepare("UPDATE installs SET d1_id = ? WHERE id = ?")
        .run(alpha.d1_id, beta.id);
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input("beta")));
      expect(e.message).toMatch(/d1_id/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });

    it("a row whose kv_id belongs to another install is refused before any write", async () => {
      const s = setup();
      const a = await s.p.create(input("alpha"));
      await failAtHealth(s, input("beta"));
      const beta = s.rows().find((r) => r.slug === "beta");
      const alpha = s.rows().find((r) => r.id === a.id);
      s.db()
        .prepare("UPDATE installs SET kv_id = ? WHERE id = ?")
        .run(alpha.kv_id, beta.id);
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input("beta")));
      expect(e.message).toMatch(/kv_id/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });
  });

  describe("broker keypair (brokerEnabled)", () => {
    const regPuts = (s: ReturnType<typeof setup>) =>
      s.fake.log
        .map((e, i) => ({ ...e, body: s.fake.raw[i]?.body ?? "" }))
        .filter(
          (e) =>
            e.method === "PUT" &&
            e.path.includes(`/namespaces/${s.regId}/values/`),
        );

    it("stays consistent across failures between add, upload and removal", async () => {
      const s = setup({ brokerEnabled: true });
      s.fake.inject((m, p) => m === "PUT" && p.endsWith("/secrets"), {
        status: 400,
      });
      await fails(s.p.create(input()));
      const [row1] = s.rows();
      const reg = () =>
        JSON.parse(s.fake.kvValues(s.regId).get(row1.id) as string);
      expect(reg().keys).toHaveLength(1);
      expect(row1.broker_kid).toBeNull();
      const before = regPuts(s).length;
      s.fake.inject(
        (m, p) => m === "PUT" && p.includes(`/namespaces/${s.regId}/values/`),
        { status: 400, skip: 1 },
      );
      await fails(s.p.create(input()));
      expect(regPuts(s).length).toBe(before + 2);
      const [row2] = s.rows();
      expect(row2.broker_kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(reg().keys).toHaveLength(2);
      const inst = await s.p.create(input());
      const [row3] = s.rows();
      const entry = reg();
      expect(entry.keys).toHaveLength(1);
      expect(entry.keys[0].kid).toBe(row3.broker_kid);
      expect(brokerKid(entry.keys[0].x)).toBe(entry.keys[0].kid);
      const digest = createHash("sha256")
        .update(Buffer.from(entry.keys[0].x, "base64url"))
        .digest("base64url");
      expect(entry.keys[0].kid).toBe(digest.slice(0, 16));
      for (const p of regPuts(s))
        if (p.status === 200)
          expect(JSON.parse(p.body).keys.length).toBeLessThanOrEqual(2);
      const sk = s
        .scriptOf(inst.id)
        ?.secrets.get("BROKER_SIGNING_KEY") as string;
      expect(SENSITIVE.has(sk)).toBe(true);
      const priv = createPrivateKey({
        key: Buffer.from(sk, "base64url"),
        format: "der",
        type: "pkcs8",
      });
      const pub = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: entry.keys[0].x },
        format: "jwk",
      });
      const msg = Buffer.from("broker round trip");
      expect(verify(null, msg, pub, sign(null, msg, priv))).toBe(true);
      expect(Buffer.from(entry.keys[0].x, "base64url")).toHaveLength(32);
    });

    it("writes exactly one entry with the exact origin and no secret, private key or email", async () => {
      const s = setup({ brokerEnabled: true });
      const inst = await s.p.create(input());
      const reg = s.fake.kvValues(s.regId);
      expect(reg.size).toBe(1);
      const raw = reg.get(inst.id) as string;
      const entry = JSON.parse(raw);
      expect(Object.keys(entry).sort()).toEqual([
        "installId",
        "keys",
        "origin",
      ]);
      expect(entry.installId).toBe(inst.id);
      expect(entry.origin).toBe("https://finqore.open-artifacts-staging.app");
      expect(Object.keys(entry.keys[0]).sort()).toEqual(["kid", "x"]);
      expect(raw).not.toContain(OWNER);
      for (const v of s.scriptOf(inst.id)?.secrets.values() ?? [])
        expect(raw).not.toContain(v);
    });

    it("is not written when brokerEnabled is false", async () => {
      const s = setup();
      const inst = await s.p.create(input());
      expect(s.fake.kvValues(s.regId).size).toBe(0);
      expect(s.scriptOf(inst.id)?.secrets.has("BROKER_SIGNING_KEY")).toBe(
        false,
      );
    });

    it("a create whose origin already belongs to another install is refused and writes nothing", async () => {
      const s = setup({ brokerEnabled: true });
      seedRow(s, {
        id: "iaaaaaaaaaaa",
        slug: "legacy",
        app: "finqore.open-artifacts-staging.app",
        content: "legacy.open-artifacts-staging.page",
        state: "active",
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(s.fake.writes()).toEqual([]);
      expect(s.fake.kvValues(s.regId).size).toBe(0);
    });

    it("a deleted finqore row blocks a new finqore (hosts and origin stay held until a purge)", async () => {
      const s = setup({ brokerEnabled: true });
      seedRow(s, {
        id: "iaaaaaaaaaaa",
        slug: "finqore",
        app: "finqore.open-artifacts-staging.app",
        content: "finqore.open-artifacts-staging.page",
        state: "deleted",
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/deleted/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("a deleted row under another slug still holds its hosts", async () => {
      const s = setup();
      s.db()
        .prepare(
          "INSERT INTO installs (id, slug, app_host, content_host, owner_email, inputs_hash, state, rl_ns, created_at, updated_at) VALUES ('iaaaaaaaaaaa', 'old', 'old.open-artifacts-staging.app', 'old.open-artifacts-staging.page', 'x@y.test', 'x', 'deleted', 1000000, 1, 1)",
        )
        .run();
      s.db()
        .prepare(
          "INSERT INTO hosts (host, install_id) VALUES (?, 'iaaaaaaaaaaa')",
        )
        .run("finqore.open-artifacts-staging.page");
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("an origin that is not byte-equal to https://<appHost> is refused", () => {
      const h = "finqore.open-artifacts-staging.app";
      expect(brokerOrigin(h)).toBe(`https://${h}`);
      expect(() => assertBrokerOrigin(`https://${h}`, h)).not.toThrow();
      for (const bad of [
        `http://${h}`,
        `https://${h}/`,
        `https://${h}:443`,
        `https://${h}/x`,
        "https://FinQore.open-artifacts-staging.app",
        `https://${h}.`,
        "https://other.open-artifacts-staging.app",
      ])
        expect(() => assertBrokerOrigin(bad, h), bad).toThrow(/origin/);
      expect(() => brokerOrigin("FinQore.open-artifacts-staging.app")).toThrow(
        /origin/,
      );
    });
  });

  it("drift test names: BROKER_SIGNING_KEY is a secret binding; BROKER_KID and BROKER_KEY appear nowhere", async () => {
    const s = setup({ brokerEnabled: true });
    await s.p.create(input());
    const listed = s.fake.log.findIndex(
      (e) => e.method === "PUT" && e.path.endsWith("/secrets"),
    );
    expect(JSON.parse(s.fake.raw[listed]?.body as string)).toMatchObject({
      name: "BROKER_SIGNING_KEY",
      type: "secret_text",
    });
    const bad = /\bBROKER_(KID|KEY)\b/;
    for (const r of s.fake.raw) expect(bad.test(r.body)).toBe(false);
    for (const f of readdirSync(new URL("../src/", import.meta.url)))
      expect(
        bad.test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")),
        f,
      ).toBe(false);
    const meta = metaOf(uploads(s.fake)[0]?.body as string);
    const t = loadTemplate();
    const known = new Set<string>([
      ...HOSTED_ADDED,
      ...Object.keys(t.vars),
      "DIRECTORY_TOKEN_KEY",
      "BROWSER",
      "EMAIL",
      "ASSETS",
      "DB",
      "FILES",
      "OAUTH_KV",
      "ARTIFACT_RUNTIME",
      "RL_ANON",
      "RL_AUTH",
      "PLAN",
    ]);
    for (const b of meta.bindings) expect(known.has(b.name), b.name).toBe(true);
  });

  describe("bundle variants and the release record (decision 8, H2)", () => {
    it("testHooks in oa-prod is refused before any Cloudflare call", async () => {
      const s = setup({ env: "prod" });
      const e = await fails(
        s.p.create(
          input("finqore", {
            testHooks: true,
            bundle: "redline",
            vars: HOOK_VARS,
          }),
        ),
      );
      expect(e.message).toMatch(/test hooks|prod/);
      expect(s.fake.log).toEqual([]);
    });

    it.each([
      ["redline into oa-prod", "prod" as const, false, "redline" as const],
      [
        "redline into a staging non-test install",
        "staging" as const,
        false,
        "redline" as const,
      ],
      [
        "release into a test install",
        "staging" as const,
        true,
        "release" as const,
      ],
    ])(
      "%s is refused with zero Cloudflare calls",
      async (_n, env, testHooks, bundle) => {
        const s = setup({ env });
        await fails(
          s.p.create(
            input("finqore", {
              testHooks,
              bundle,
              vars: testHooks ? HOOK_VARS : {},
            }),
          ),
        );
        expect(s.fake.log).toEqual([]);
      },
    );

    it("redline on an account target is refused (hooks only in the oa-staging namespace)", async () => {
      const s = setup({ target: { kind: "account" } });
      await fails(s.p.create(hookInput("finqore")));
      expect(s.fake.log).toEqual([]);
    });

    it("a mislabelled bundle (redline bytes served as release) is refused with zero calls", async () => {
      const s = setup({
        bundles: async (version) => makeBundle("redline", version),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/release record/);
      expect(s.fake.log).toEqual([]);
    });

    it.each(["prod", "staging"] as const)(
      "a missing release record in %s is refused with zero calls",
      async (env) => {
        const s = setup({ env, releaseRecord: async () => null });
        const e = await fails(s.p.create(input()));
        expect(e.message).toMatch(/no release record/);
        expect(s.fake.log).toEqual([]);
      },
    );

    it.each([
      [
        'a string define "false" is invalid',
        { ...recordOf("release"), defines: { [TEST_HOOKS_DEFINE]: "false" } },
      ],
      [
        "a release record whose define is true",
        { ...recordOf("release"), defines: { [TEST_HOOKS_DEFINE]: true } },
      ],
      ["a record for another variant", recordOf("redline")],
      ["a record for another version", recordOf("release", "0.22.0")],
      [
        "a record with another sha256",
        { ...recordOf("release"), sha256: "0".repeat(64) },
      ],
    ])("%s is refused with zero calls", async (_n, rec) => {
      const s = setup({
        env: "prod",
        releaseRecord: async () => rec as unknown as ReleaseRecord,
      });
      await fails(s.p.create(input()));
      expect(s.fake.log).toEqual([]);
    });

    it('a redline record with the string "true" is refused as invalid, not treated as true', async () => {
      const s = setup({
        releaseRecord: async (version, v) =>
          ({
            ...recordOf(v, version),
            defines: { [TEST_HOOKS_DEFINE]: "true" },
          }) as unknown as ReleaseRecord,
      });
      const e = await fails(s.p.create(hookInput()));
      expect(e.message).toMatch(/boolean/);
      expect(s.fake.log).toEqual([]);
    });

    it("the uploaded bytes are hashed and must equal the record", async () => {
      const s = setup();
      const inst = await s.p.create(input());
      const sc = s.scriptOf(inst.id);
      const rel = makeBundle("release");
      expect(new TextDecoder().decode(sc?.modules.get("index.js")?.bytes)).toBe(
        new TextDecoder().decode(rel.modules[0]?.bytes),
      );
      expect(bundleSha256(rel)).toBe(recordOf("release").sha256);
      const names = sc?.metadata.bindings.map((b: { name: string }) => b.name);
      expect(names).not.toContain("TEST_HOOKS");
      expect(names).not.toContain("TEST_HOOK_KEY");
      expect(names).not.toContain("TEST_DOMAIN");
      expect(JSON.stringify(sc?.metadata)).not.toMatch(/hook/i);
      const audit = s
        .db()
        .prepare(
          "SELECT detail FROM hosted_audit WHERE action = 'create.upload'",
        )
        .get() as { detail: string };
      expect(JSON.parse(audit.detail).sha256).toBe(recordOf("release").sha256);
    });

    it("a bundle whose bytes change between pre-flight and upload is refused before the upload (N3)", async () => {
      const good = makeBundle("release");
      const evil = makeBundle("redline");
      let reads = 0;
      const s = setup({
        bundles: async () => {
          const b = { ...good };
          Object.defineProperty(b, "modules", {
            get: () => (++reads === 1 ? good.modules : evil.modules),
          });
          return b;
        },
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/about to be uploaded/);
      expect(uploads(s.fake)).toHaveLength(0);
    });

    it("bundleSha256 changes with any module byte, name or the main module", () => {
      const a = makeBundle("release");
      expect(bundleSha256(a)).toMatch(/^[0-9a-f]{64}$/);
      expect(bundleSha256(makeBundle("redline"))).not.toBe(bundleSha256(a));
      expect(bundleSha256({ ...a, mainModule: "other.js" })).not.toBe(
        bundleSha256(a),
      );
    });
  });

  describe("TEST_DOMAIN", () => {
    it("a test-hook install without TEST_DOMAIN is refused with zero calls", async () => {
      const s = setup();
      const e = await fails(
        s.p.create(input("redqa", { testHooks: true, bundle: "redline" })),
      );
      expect(e.message).toMatch(/TEST_DOMAIN/);
      expect(s.fake.log).toEqual([]);
    });
    it("TEST_DOMAIN on a non-test install is refused with zero calls", async () => {
      const s = setup();
      await fails(s.p.create(input("finqore", { vars: HOOK_VARS })));
      expect(s.fake.log).toEqual([]);
    });
    it("TEST_DOMAIN in oa-prod is refused with zero calls", async () => {
      const s = setup({ env: "prod" });
      await fails(s.p.create(input("finqore", { vars: HOOK_VARS })));
      expect(s.fake.log).toEqual([]);
    });
    it("TEST_DOMAIN must be a lowercase hostname", async () => {
      const s = setup();
      for (const bad of [
        "Redline.test",
        "redline",
        "x@redline.test",
        "redline.test.",
      ])
        await fails(
          s.p.create(
            input("redqa", {
              testHooks: true,
              bundle: "redline",
              vars: { TEST_DOMAIN: bad },
            }),
          ),
        );
      expect(s.fake.log).toEqual([]);
    });
    it("metadata allows TEST_DOMAIN only on a test-hook install outside prod", () => {
      const base = {
        id: "iabcdefghjk2",
        appHost: "a.app.test",
        contentHost: "a.content.test",
        ownerEmail: "o@x.test",
      };
      const res = {
        d1Id: "11111111-2222-4333-8444-555555555555",
        kvId: "0123456789abcdef0123456789abcdef",
        version: "1.2.3",
        rlNs: 1_000_000,
        doMigrationTag: null,
        env: "staging" as const,
        target: "namespace" as const,
        mode: "update" as const,
        assetsJwt: "jwt",
        mainModule: "index.js",
      };
      const m = userWorkerMetadata(
        { ...base, vars: HOOK_VARS, testHooks: true },
        res,
      );
      expect(m.bindings.find((b) => b.name === "TEST_DOMAIN")).toMatchObject({
        type: "plain_text",
        text: "redline.test",
      });
      expect(() =>
        userWorkerMetadata({ ...base, vars: HOOK_VARS, testHooks: false }, res),
      ).toThrow(/TEST_DOMAIN/);
      expect(() =>
        userWorkerMetadata(
          { ...base, vars: HOOK_VARS, testHooks: false },
          { ...res, env: "prod" },
        ),
      ).toThrow(/TEST_DOMAIN/);
      THROWN.push("metadata TEST_DOMAIN");
    });
  });

  it("on staging the hook-key file is 0600, matches TEST_HOOK_KEY and never appears in output", async () => {
    const s = setup();
    const inst = await s.p.create(hookInput());
    PRINTABLE.push(JSON.stringify(inst));
    const f = join(s.patDir, "redqa.open-artifacts-staging.app-hook-key");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const key = readFileSync(f, "utf8").trim();
    expect(SENSITIVE.has(key)).toBe(true);
    expect(s.scriptOf(inst.id)?.secrets.get("TEST_HOOK_KEY")).toBe(key);
    expect(s.rows()[0].test_hooks).toBe(1);
    const b = (n: string) =>
      s
        .scriptOf(inst.id)
        ?.metadata.bindings.find((x: { name: string }) => x.name === n);
    expect(b("TEST_HOOKS")).toMatchObject({ type: "plain_text", text: "1" });
    expect(b("TEST_DOMAIN")).toMatchObject({
      type: "plain_text",
      text: "redline.test",
    });
    expect(JSON.stringify(inst)).not.toContain(key);
  });

  it("the hook-key file is never written through a symlink (O_NOFOLLOW)", async () => {
    const s = setup();
    const victim = join(s.patDir, "victim");
    writeFileSync(victim, "keep");
    const f = join(s.patDir, "redqa.open-artifacts-staging.app-hook-key");
    symlinkSync(victim, f);
    await fails(s.p.create(hookInput()));
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(lstatSync(f).isSymbolicLink()).toBe(true);
    expect(uploads(s.fake)).toHaveLength(0);
  });

  it("secrets are 48-byte random, differ between two installs, and never appear in the call log's printable fields or thrown errors", async () => {
    const s = setup();
    const a = await s.p.create(input("alpha"));
    const b = await s.p.create(input("beta"));
    const sa = s.scriptOf(a.id)?.secrets as Map<string, string>;
    const sb = s.scriptOf(b.id)?.secrets as Map<string, string>;
    for (const k of [
      "SESSION_SECRET",
      "CONTENT_SIGNING_KEY",
      "DIRECTORY_TOKEN_KEY",
    ]) {
      expect(Buffer.from(sa.get(k) as string, "base64url")).toHaveLength(48);
      expect(Buffer.from(sb.get(k) as string, "base64url")).toHaveLength(48);
      expect(sa.get(k)).not.toBe(sb.get(k));
      expect(SENSITIVE.has(sa.get(k) as string)).toBe(true);
    }
    expect(new Set(sa.values()).size).toBe(sa.size);
  });

  it("a rerun/resume of the same install does not mint a new SESSION_SECRET, even when it uploads", async () => {
    const s = setup();
    await failAtHealth(s);
    const [row] = s.rows();
    const first = s.scriptOf(row.id)?.secrets.get("SESSION_SECRET");
    s.scriptOf(row.id)?.secrets.delete("DIRECTORY_TOKEN_KEY");
    await s.p.create(input());
    const ups = uploads(s.fake);
    expect(ups).toHaveLength(2);
    expect(secretBindings(metaOf(ups[1]?.body as string))).not.toContain(
      "SESSION_SECRET",
    );
    expect(s.scriptOf(row.id)?.secrets.get("SESSION_SECRET")).toBe(first);
  });

  it("assertSessionSecret refuses short, malformed or reused values", () => {
    const ok = Buffer.alloc(48, 7).toString("base64url");
    expect(() => assertSessionSecret(ok, [])).not.toThrow();
    expect(() =>
      assertSessionSecret(Buffer.alloc(31, 1).toString("base64url"), []),
    ).toThrow(/32 bytes/);
    expect(() => assertSessionSecret("not base64url!", [])).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => assertSessionSecret(ok, [ok])).toThrow(/distinct/);
    THROWN.push("assertSessionSecret");
  });

  it("resumes after an upload failure without duplicating resources", async () => {
    const s = setup();
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/[^/]+$/.test(p), {
      status: 400,
    });
    await fails(s.p.create(input()));
    expect(s.fake.kvValues(s.hostsId).size).toBe(0);
    const inst = await s.p.create(input());
    const n = `oa-s-${inst.id}`;
    expect([...s.fake.d1.values()].filter((d) => d.name === n)).toHaveLength(1);
    expect([...s.fake.r2].filter((b) => b === n)).toHaveLength(1);
    expect(
      [...s.fake.kv.values()].filter((k) => k.title === `${n}-oauth`),
    ).toHaveLength(1);
    expect([...(s.scriptOf(inst.id)?.secrets.keys() ?? [])].sort()).toEqual([
      "CONTENT_SIGNING_KEY",
      "DIRECTORY_TOKEN_KEY",
      "SESSION_SECRET",
    ]);
  });

  it("hosts are written last: kvPut(HOSTS) comes after the script upload", async () => {
    const s = setup({ brokerEnabled: true });
    await s.p.create(input());
    const w = s.fake.writes();
    const hostIdx = w.findIndex((x) =>
      x.includes(`/namespaces/${s.hostsId}/values/`),
    );
    const upIdx = w.findIndex((x) => /^PUT .*\/scripts\/[^/]+$/.test(x));
    const brokerIdx = w
      .map((x) => x.includes(`/namespaces/${s.regId}/values/`))
      .lastIndexOf(true);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(brokerIdx).toBeGreaterThan(upIdx);
    expect(hostIdx).toBeGreaterThan(upIdx);
    expect(hostIdx).toBeGreaterThan(brokerIdx);
    const after = w
      .slice(hostIdx)
      .filter(
        (x) =>
          !x.includes("/query") && !x.includes(`/namespaces/${s.hostsId}/`),
      );
    expect(after).toEqual([]);
  });

  describe("slug or host already taken fails before any Cloudflare write", () => {
    it("a host mapped in HOSTS to another install", async () => {
      const s = setup();
      s.fake
        .kvValues(s.hostsId)
        .set("finqore.open-artifacts-staging.page", "izzzzzzzzzzz");
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(s.fake.writes()).toEqual([]);
    });
    it("a slug held by an active install", async () => {
      const s = setup();
      seedRow(s, {
        id: "iaaaaaaaaaaa",
        slug: "finqore",
        app: "finqore.open-artifacts-staging.app",
        content: "finqore.open-artifacts-staging.page",
        state: "active",
      });
      await fails(s.p.create(input()));
      expect(s.fake.writes()).toEqual([]);
    });
    it("an invalid or reserved slug makes zero calls", async () => {
      const s = setup();
      await fails(s.p.create(input("auth")));
      await fails(s.p.create(input("Bad_Slug")));
      expect(s.fake.log).toEqual([]);
    });
    it("the other env's domains are refused with zero calls", async () => {
      const s = setup();
      const e = await fails(
        s.mk({ domains: HOSTED_DOMAINS.prod }).create(input()),
      );
      expect(e.message).toMatch(/domains/);
      expect(s.fake.log).toEqual([]);
    });
  });

  it("the PAT file is 0600, minted for the owner, and its content never appears in returned values", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    expect(statSync(inst.patFile).mode & 0o777).toBe(0o600);
    const pat = readFileSync(inst.patFile, "utf8").trim();
    expect(isPat(pat)).toBe(true);
    expect(SENSITIVE.has(pat)).toBe(true);
    expect(JSON.stringify(inst)).not.toContain(pat);
    expect(JSON.stringify(s.p.notes)).not.toContain(pat);
    const idb = s.fake.d1.get(s.rows()[0].d1_id)?.db as DatabaseSync;
    const hash = createHash("sha256").update(pat).digest("hex");
    expect(
      idb
        .prepare("SELECT revoked_at FROM tokens WHERE token_hash = ?")
        .get(hash),
    ).toEqual({ revoked_at: null });
    expect(JSON.stringify(s.fake.log) + JSON.stringify(s.rows())).not.toContain(
      pat,
    );
  });

  it("the PAT file is never written through a symlink (O_NOFOLLOW)", async () => {
    const s = setup();
    const victim = join(s.patDir, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(
      victim,
      join(s.patDir, "finqore.open-artifacts-staging.app-pat-token"),
    );
    await fails(s.p.create(input()));
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(
      lstatSync(
        join(s.patDir, "finqore.open-artifacts-staging.app-pat-token"),
      ).isSymbolicLink(),
    ).toBe(true);
  });

  describe("Durable Object migration tag (decision 5)", () => {
    const tpl = (tags: string[]) => {
      const t = structuredClone(loadTemplate());
      t.migrations = tags.map((tag, i) =>
        i === 0
          ? { tag, new_sqlite_classes: ["ArtifactRuntime"] }
          : { tag, new_sqlite_classes: [`C${i}`] },
      );
      return t;
    };

    it("the first upload sends the full chain with new_tag and no old_tag; no probe on a missing script", async () => {
      const s = setup({ template: tpl(["v1", "v2"]) });
      await s.p.create(input());
      const ups = uploads(s.fake);
      expect(ups).toHaveLength(1);
      const m = metaOf(ups[0]?.body as string).migrations;
      expect(m.old_tag).toBeUndefined();
      expect(m.new_tag).toBe("v2");
      expect(m.steps).toHaveLength(2);
      expect(s.fake.log.some((e) => e.status === 412)).toBe(false);
      expect(s.rows()[0].do_migration_tag).toBe("v2");
    });

    it("a journal tag set while the script is missing sends the full chain, no old_tag", async () => {
      const s = setup({ template: tpl(["v1", "v2"]) });
      await failAtHealth(s);
      const [row] = s.rows();
      s.fake.scripts.delete(`oa-staging/${`oa-s-${row.id}`}`);
      await s.p.create(input());
      const ups = uploads(s.fake);
      expect(ups.map((u) => u.status)).toEqual([200, 200]);
      const m = metaOf(ups[1]?.body as string).migrations;
      expect(m.old_tag).toBeUndefined();
      expect(m.steps).toHaveLength(2);
    });

    it("a rerun at the same tag sends no migrations", async () => {
      const s = setup({ template: tpl(["v1", "v2"]) });
      await failAtHealth(s);
      const [row] = s.rows();
      s.scriptOf(row.id)?.secrets.delete("DIRECTORY_TOKEN_KEY");
      await s.p.create(input());
      const ups = uploads(s.fake);
      expect(ups).toHaveLength(2);
      expect(metaOf(ups[1]?.body as string).migrations).toBeUndefined();
    });

    it("a rerun whose journal is empty probes with a sentinel old_tag, learns the live tag and sends nothing when it is current", async () => {
      const s = setup({ template: tpl(["v1", "v2"]) });
      await failAtHealth(s);
      const [row] = s.rows();
      s.db()
        .prepare("UPDATE installs SET do_migration_tag = NULL WHERE id = ?")
        .run(row.id);
      await s.p.create(input());
      const ups = uploads(s.fake);
      expect(ups.map((u) => u.status)).toEqual([200, 412, 200]);
      expect(metaOf(ups[1]?.body as string).migrations.old_tag).toBe(
        "__oa_probe__",
      );
      expect(metaOf(ups[2]?.body as string).migrations).toBeUndefined();
      expect(s.scriptOf(row.id)?.migrationTag).toBe("v2");
      expect(s.rows()[0].do_migration_tag).toBe("v2");
    });

    it("a rerun whose journal is behind probes and sends only the missing steps", async () => {
      const s = setup({ template: tpl(["v1", "v2"]) });
      await failAtHealth(s);
      const [row] = s.rows();
      s.db()
        .prepare("UPDATE installs SET do_migration_tag = 'v1' WHERE id = ?")
        .run(row.id);
      const p2 = s.mk({ template: tpl(["v1", "v2", "v3"]) });
      await p2.create(input());
      const ups = uploads(s.fake);
      expect(ups.map((u) => u.status)).toEqual([200, 412, 200]);
      const m = metaOf(ups[2]?.body as string).migrations;
      expect(m).toMatchObject({ old_tag: "v2", new_tag: "v3" });
      expect(m.steps).toHaveLength(1);
      expect(s.scriptOf(row.id)?.migrationTag).toBe("v3");
      expect(s.rows()[0].do_migration_tag).toBe("v3");
    });

    it("a live tag the release does not know is refused (forward-fix only)", async () => {
      const s = setup({ template: tpl(["v1", "v2"]) });
      await failAtHealth(s);
      const [row] = s.rows();
      s.db()
        .prepare("UPDATE installs SET do_migration_tag = NULL WHERE id = ?")
        .run(row.id);
      const e = await fails(s.mk({ template: tpl(["v1"]) }).create(input()));
      expect(e.message).toMatch(/forward-fix/);
      expect(uploads(s.fake).map((u) => u.status)).toEqual([200, 412]);
    });
  });

  describe("assets (decision 6)", () => {
    it("manifest hashes are 32 hex, uploads go to the account assets route with the session jwt, 202 then 201", async () => {
      const s = setup();
      await s.p.create(input());
      const sess = s.fake.log.findIndex((e) =>
        e.path.endsWith("/assets-upload-session"),
      );
      expect(s.fake.log[sess]?.path).toContain(
        "/workers/dispatch/namespaces/oa-staging/scripts/",
      );
      const manifest = JSON.parse(s.fake.raw[sess]?.body as string).manifest;
      expect(Object.keys(manifest).sort()).toEqual(["/app.js", "/index.html"]);
      for (const v of Object.values(manifest) as { hash: string }[])
        expect(v.hash).toMatch(/^[0-9a-f]{32}$/);
      expect(manifest["/app.js"].hash).toBe(
        assetHash(readFileSync(join(s.assetsDir, "app.js"))),
      );
      const ups = s.fake.log.filter((e) =>
        e.path.includes("/workers/assets/upload"),
      );
      expect(ups.map((e) => e.path)).toEqual([
        `/accounts/${s.fake.accountId}/workers/assets/upload?base64=true`,
        `/accounts/${s.fake.accountId}/workers/assets/upload?base64=true`,
      ]);
      expect(ups.map((e) => e.status)).toEqual([202, 201]);
      const meta = metaOf(uploads(s.fake)[0]?.body as string);
      expect(meta.assets.jwt).toMatch(/^jwt-done-/);
      expect(meta.keep_assets).toBeUndefined();
    });

    it("cf.assetsUpload with nothing new returns the session jwt without an upload call", async () => {
      const fake = new FakeCf();
      FAKES.push(fake);
      SENSITIVE.add(fake.token);
      const cf = cfClient({
        accountId: fake.accountId,
        token: fake.token,
        fetch: fake.fetch,
      });
      const dir = mkdtempSync(join(tmpdir(), "oa-t4-a-"));
      writeFileSync(join(dir, "a.txt"), "a");
      fake.assetHashes.add(assetHash(enc("a")));
      const r = await cf.assetsUpload(
        { kind: "namespace", ns: "oa-staging" },
        "oa-s-iaaaaaaaaaaa",
        dir,
      );
      expect(r.jwt).toMatch(/^jwt-sess-/);
      expect(fake.log.some((e) => e.path.includes("/assets/upload"))).toBe(
        false,
      );
    });
  });

  describe("ratelimits (decision 12)", () => {
    it("RL_ANON gets rlNs and RL_AUTH rlNs + 1; two installs never share an id", async () => {
      const s = setup();
      const a = await s.p.create(input("alpha"));
      const b = await s.p.create(input("beta"));
      const ids: string[] = [];
      for (const inst of [a, b]) {
        const row = s.rows().find((r) => r.id === inst.id);
        expect(row.rl_ns % 8).toBe(0);
        expect(row.rl_ns).toBeGreaterThanOrEqual(1_000_000);
        expect(row.rl_ns).toBeLessThan(2_000_000);
        const rl = s
          .scriptOf(inst.id)
          ?.metadata.bindings.filter(
            (x: { type: string }) => x.type === "ratelimit",
          );
        const by = Object.fromEntries(
          rl.map((x: { name: string; namespace_id: string }) => [
            x.name,
            x.namespace_id,
          ]),
        );
        expect(by).toEqual({
          RL_ANON: String(row.rl_ns),
          RL_AUTH: String(row.rl_ns + 1),
        });
        ids.push(...Object.values(by as Record<string, string>));
      }
      expect(new Set(ids).size).toBe(4);
      expect(ids).not.toContain("1001");
      expect(ids).not.toContain("1002");
    });

    it.each([
      [
        "a literal id >= 1,000,000",
        (t: Record<string, unknown[]>) => {
          (t.ratelimits[0] as { namespace_id: string }).namespace_id =
            "1000000";
        },
      ],
      [
        "more than 8 entries",
        (t: Record<string, unknown[]>) => {
          t.ratelimits = Array.from({ length: 9 }, (_, i) => ({
            name: `RL_${i}`,
            namespace_id: String(2000 + i),
            simple: { limit: 1, period: 60 },
          }));
        },
      ],
    ])(
      "a template with %s is refused before any Cloudflare call",
      async (_n, edit) => {
        const t = structuredClone(loadTemplate());
        edit(t);
        const s = setup({ template: t });
        await fails(s.p.create(input()));
        expect(s.fake.log).toEqual([]);
      },
    );
  });

  describe("env and target (decisions 1, 2)", () => {
    it("a namespace target of the other env is refused with zero calls", async () => {
      const s = setup();
      const e = await fails(
        s.mk({ target: { kind: "namespace", ns: "oa-prod" } }).create(input()),
      );
      expect(e.message).toMatch(/namespace/);
      expect(s.fake.log).toEqual([]);
    });
  });

  describe("token check (decision 9)", () => {
    it.each([
      ["inactive", { status: "disabled" }],
      [
        "not yet valid",
        { not_before: new Date(NOW + 3_600_000).toISOString() },
      ],
      ["no expiry", { expires_on: undefined }],
      [
        "expiry over 30 days out",
        { expires_on: new Date(NOW + 31 * 86_400_000).toISOString() },
      ],
      ["expired", { expires_on: new Date(NOW - 1000).toISOString() }],
    ])("a token that is %s is refused before any write", async (_n, over) => {
      const s = setup();
      Object.assign(s.fake.tokenInfo, over);
      for (const [k, v] of Object.entries(over))
        if (v === undefined) delete s.fake.tokenInfo[k];
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/token/);
      expect(s.fake.writes()).toEqual([]);
      expect(s.fake.log.map((e) => e.path)).toEqual(["/user/tokens/verify"]);
    });

    it.each([401, 403])(
      "a %s on the Workers Scripts read is refused before any write",
      async (status) => {
        const s = setup();
        s.fake.scriptsReadStatus = status;
        const e = await fails(s.p.create(input()));
        expect(e.message).toMatch(/Workers Scripts/);
        expect(s.fake.log.map((e) => e.path)).toEqual([
          "/user/tokens/verify",
          `/accounts/${s.fake.accountId}/workers/scripts?per_page=1`,
        ]);
      },
    );

    it("warns when the token expires within 5 days, and never calls a zone, DNS or email API", async () => {
      const s = setup();
      s.fake.tokenInfo.expires_on = new Date(
        NOW + 2 * 86_400_000,
      ).toISOString();
      const inst = await s.p.create(input());
      expect(s.p.notes.join("\n")).toMatch(/expires/);
      for (const e of s.fake.log)
        expect(e.path).not.toMatch(
          /\/zones|dns_records|custom_domains|\/workers\/domains|\/email\//,
        );
      const from = s
        .scriptOf(inst.id)
        ?.metadata.bindings.find(
          (b: { name: string }) => b.name === "EMAIL_FROM",
        );
      expect(from.text).toBe("noreply@finqore.mail.open-artifacts-staging.app");
    });
  });

  describe("health check", () => {
    it("waits for /healthz and fails after 120 s with the row left creating", async () => {
      const s = setup();
      const e = await failAtHealth(s);
      expect(e.message).toMatch(/healthz/);
      expect(s.rows()[0].state).toBe("creating");
      expect(s.clock.now() - NOW).toBeGreaterThanOrEqual(120_000);
    });

    it("requireInstallId makes the check insist on installId (Task 6b)", async () => {
      const s = setup();
      const p = s.mk({ requireInstallId: true });
      await fails(p.create(input()));
      s.fake.health = (sc) => ({
        ok: true,
        plan: "paid",
        version: "0.23.0",
        installId: sc.name.slice(5),
      });
      await p.create(input());
      expect(s.rows()[0].state).toBe("active");
    });
  });

  it("errors are scrubbed in every string property, including Cloudflare's own text", async () => {
    const s = setup();
    s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"), {
      message: `bucket refused for ${OWNER}`,
    });
    const e = await fails(s.p.create(input()));
    expect(e).toBeInstanceOf(CfError);
    expect((e as CfError).cfMessage).not.toContain(OWNER);
    expect(JSON.stringify(e)).not.toContain(OWNER);
    expect(e.message).not.toContain(OWNER);
  });
});

describe("cfClient", () => {
  const client = () => {
    const fake = new FakeCf();
    FAKES.push(fake);
    SENSITIVE.add(fake.token);
    const cf = cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    return { fake, cf };
  };

  it("retries 429 and 5xx three times and never puts the request body in the error", async () => {
    const { fake, cf } = client();
    const secret = "s3cr3t-value-that-must-not-leak-0123456789";
    SENSITIVE.add(secret);
    fake.inject((m, p) => m === "PUT" && p.endsWith("/secrets"), {
      status: 503,
      times: 3,
    });
    const e = await fails(
      cf.secretPut(
        { kind: "namespace", ns: "oa-staging" },
        "oa-s-iaaaaaaaaaaa",
        "SESSION_SECRET",
        secret,
      ),
    );
    expect(e).toBeInstanceOf(CfError);
    expect((e as CfError).status).toBe(503);
    expect(fake.log.filter((x) => x.path.endsWith("/secrets"))).toHaveLength(3);
    expect(e.message).not.toContain(secret);
    expect(e.message).not.toContain(fake.token);
    fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"), {
      status: 429,
    });
    await cf.r2Create("oa-s-x");
    expect(fake.r2.has("oa-s-x")).toBe(true);
  });

  it("does not retry other 4xx", async () => {
    const { fake, cf } = client();
    fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"), {
      status: 400,
    });
    await fails(cf.r2Create("oa-s-x"));
    expect(fake.log).toHaveLength(1);
  });

  it("kvGet returns null only for a missing key, and throws for a missing namespace", async () => {
    const { fake, cf } = client();
    const id = fake.seedKv("oa-s-hosts");
    expect(await cf.kvGet(id, "nope.example")).toBeNull();
    const e = await fails(cf.kvGet("f".repeat(32), "nope.example"));
    expect((e as CfError).status).toBe(404);
  });

  it("d1Batch runs all statements or none", async () => {
    const { fake, cf } = client();
    const id = fake.seedD1("oa-s-x", "CREATE TABLE t (k TEXT PRIMARY KEY)");
    await fails(
      cf.d1Batch(id, [
        { sql: "INSERT INTO t (k) VALUES (?1)", params: ["a"] },
        { sql: "INSERT INTO t (k) VALUES (?1)", params: ["a"] },
      ]),
    );
    const r = await cf.d1Query(id, "SELECT count(*) AS n FROM t");
    expect(r[0]?.results).toEqual([{ n: 0 }]);
  });
});

describe("platform D1 migration (decisions 10, M1, M3)", () => {
  const db = () => {
    const d = new Sqlite(":memory:");
    for (const s of splitSql(PLATFORM_SQL)) d.exec(s);
    return d;
  };
  const row = (o: Record<string, unknown> = {}) => ({
    id: "i1",
    slug: "a",
    app_host: "a.app.test",
    content_host: "a.content.test",
    owner_email: "o@x.test",
    inputs_hash: "h",
    rl_ns: 1_000_000,
    state: "creating",
    test_hooks: 0,
    created_at: 1,
    updated_at: 1,
    ...o,
  });
  const ins = (d: Sqlite, r: Record<string, unknown>) => {
    const k = Object.keys(r);
    d.prepare(
      `INSERT INTO installs (${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`,
    ).run(...(Object.values(r) as (string | number | null)[]));
  };

  it("has the full installs schema", () => {
    const cols = db()
      .prepare("PRAGMA table_info(installs)")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(cols).toEqual([
      "id",
      "slug",
      "app_host",
      "content_host",
      "owner_email",
      "d1_id",
      "kv_id",
      "version",
      "previous_version",
      "rl_ns",
      "do_migration_tag",
      "test_hooks",
      "inputs_hash",
      "broker_kid",
      "state",
      "created_at",
      "updated_at",
    ]);
  });

  it.each([
    "slug",
    "app_host",
    "content_host",
    "rl_ns",
    "state",
    "owner_email",
    "created_at",
    "updated_at",
    "inputs_hash",
  ])("installs.%s is NOT NULL", (col) => {
    const d = db();
    expect(() => ins(d, row({ [col]: null }))).toThrow(/NOT NULL/);
  });

  it.each([
    [
      "slug",
      {
        id: "i2",
        app_host: "b.app.test",
        content_host: "b.content.test",
        rl_ns: 1_000_008,
      },
    ],
    [
      "app_host",
      { id: "i2", slug: "b", content_host: "b.content.test", rl_ns: 1_000_008 },
    ],
    [
      "content_host",
      { id: "i2", slug: "b", app_host: "b.app.test", rl_ns: 1_000_008 },
    ],
    [
      "rl_ns",
      {
        id: "i2",
        slug: "b",
        app_host: "b.app.test",
        content_host: "b.content.test",
      },
    ],
  ])("installs.%s is UNIQUE", (_c, over) => {
    const d = db();
    ins(d, row());
    expect(() => ins(d, row(over))).toThrow(/UNIQUE/);
  });

  it("rl_ns is a multiple of 8; state, test_hooks and app_host <> content_host are checked; deleted is a state", () => {
    const d = db();
    expect(() => ins(d, row({ rl_ns: 1_000_004 }))).toThrow(/CHECK/);
    expect(() => ins(d, row({ state: "bogus" }))).toThrow(/CHECK/);
    expect(() => ins(d, row({ test_hooks: 2 }))).toThrow(/CHECK/);
    expect(() => ins(d, row({ content_host: "a.app.test" }))).toThrow(/CHECK/);
    ins(d, row({ state: "deleted" }));
  });

  it("hosts holds each host once, across app and content columns of different installs", () => {
    const d = db();
    ins(d, row());
    ins(
      d,
      row({
        id: "i2",
        slug: "b",
        app_host: "b.app.test",
        content_host: "b.content.test",
        rl_ns: 1_000_008,
      }),
    );
    const h = d.prepare("INSERT INTO hosts (host, install_id) VALUES (?, ?)");
    h.run("a.content.test", "i1");
    expect(() => h.run("a.content.test", "i2")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => h.run(null, "i2")).toThrow();
    expect(() => h.run("c.app.test", null)).toThrow(/NOT NULL/);
  });

  it("hosted_audit is append-only", () => {
    const d = db();
    d.prepare(
      "INSERT INTO hosted_audit (at, install_id, action) VALUES (1, 'i', 'x')",
    ).run();
    expect(() =>
      d.prepare("UPDATE hosted_audit SET action = 'y'").run(),
    ).toThrow(/append-only/);
    expect(() => d.prepare("DELETE FROM hosted_audit").run()).toThrow(
      /append-only/,
    );
  });
});

/** Every printable surface of every fake and provisioner created in this file. */
function haystacks(): { all: string; rows: string } {
  const parts = [...THROWN, ...PRINTABLE];
  const rows: string[] = [];
  for (const f of FAKES) {
    parts.push(JSON.stringify(f.log));
    for (const [, d] of f.d1) {
      if (!d.name.endsWith("platform")) continue;
      parts.push(
        JSON.stringify(d.db.prepare("SELECT * FROM hosted_audit").all()),
      );
      rows.push(JSON.stringify(d.db.prepare("SELECT * FROM installs").all()));
      rows.push(JSON.stringify(d.db.prepare("SELECT * FROM hosts").all()));
    }
  }
  for (const p of PROVS) parts.push(JSON.stringify(p.notes));
  return { all: parts.join("\n"), rows: rows.join("\n") };
}

afterAll(() => {
  const { all, rows } = haystacks();
  const leaks = [...SENSITIVE, ...EMAILS].filter(
    (v) => v.length >= 8 && all.includes(v),
  );
  // Platform rows hold the owner email by design; they must hold no secret.
  const rowLeaks = [...SENSITIVE].filter(
    (v) => v.length >= 8 && rows.includes(v),
  );
  if (leaks.length + rowLeaks.length > 0)
    throw new Error(
      `${leaks.length + rowLeaks.length} sensitive value(s) leaked into errors, logs, notes or platform rows`,
    );
});

describe("no secret in any error or printable output", () => {
  it("collected values", () => {
    expect(SENSITIVE.size).toBeGreaterThan(50);
    expect(THROWN.length).toBeGreaterThan(20);
    const { all, rows } = haystacks();
    for (const v of [...SENSITIVE, ...EMAILS])
      if (v.length >= 8)
        expect(all.includes(v), "a sensitive value leaked").toBe(false);
    for (const v of SENSITIVE)
      if (v.length >= 8)
        expect(rows.includes(v), "a secret is in a platform row").toBe(false);
  });
});
