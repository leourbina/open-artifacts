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
import { DatabaseSync } from "node:sqlite";
import { isPat } from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";
import { assetHash, CfError, cfClient, type Target } from "../src/cf.js";
import { HOSTED_ADDED, loadTemplate } from "../src/metadata.js";
import {
  ENV_PREFIX,
  type Env,
  ForeignResource,
  platformNames,
} from "../src/names.js";
import { inputsHash } from "../src/platform.js";
import {
  assertBrokerOrigin,
  assertSessionSecret,
  brokerKid,
  brokerOrigin,
  bundleHash,
  type HostedBundle,
  NAMESPACES,
  TEST_HOOKS_DEFINE,
  type WfpOptions,
  WfpProvisioner,
} from "../src/wfp.js";
import { type FakeCf as Fake, FakeCf, splitSql } from "./fake-cf.js";

const NOW = Date.parse("2026-10-22T00:00:00Z");
const ROOT = new URL("../../../", import.meta.url);
const PLATFORM_SQL = readFileSync(
  new URL("apps/platform-db/migrations/0001_installs.sql", ROOT),
  "utf8",
);
const SERVER_MIGRATIONS = readdirSync(new URL("apps/server/migrations/", ROOT))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const DOMAINS: Record<Env, { app: string; content: string }> = {
  staging: {
    app: "open-artifacts-staging.app",
    content: "open-artifacts-staging.page",
  },
  prod: { app: "open-artifacts.app", content: "open-artifacts.page" },
};
const OWNER = "owner@finqore.test";

// Every sensitive value seen in any test; scanned against every thrown
// message and printable output at the end of the file.
const SENSITIVE = new Set<string>();
const THROWN: string[] = [];
const PRINTABLE: string[] = [];

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
): HostedBundle {
  const define = variant === "redline" ? "true" : "false";
  const b = {
    variant,
    defines: { [TEST_HOOKS_DEFINE]: define } as HostedBundle["defines"],
    modules: [
      {
        name: "index.js",
        type: "esm" as const,
        bytes: enc(
          `const hooksAllowed = ${define};\nexport default { fetch() { return new Response(String(hooksAllowed)); } };\n`,
        ),
      },
    ],
    mainModule: "index.js",
    assetsDir: "",
    version,
  };
  return { ...b, hash: bundleHash(b) };
}

type SetupOpts = {
  env?: Env;
  target?: Target;
  brokerEnabled?: boolean;
  template?: WfpOptions["template"];
  bundles?: WfpOptions["bundles"];
};

function setup(o: SetupOpts = {}) {
  const fake = new FakeCf({ now: NOW });
  SENSITIVE.add(fake.token);
  SENSITIVE.add(OWNER);
  const env = o.env ?? "staging";
  const pdbName = platformNames(env).db;
  const pdb = fake.seedD1(pdbName, PLATFORM_SQL);
  const hostsTitle = `${ENV_PREFIX[env]}hosts`;
  const hostsId = fake.seedKv(hostsTitle);
  const regTitle = platformNames(env).registry;
  const regId = fake.seedKv(regTitle);
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
  const bundles =
    o.bundles ??
    (async (v: "release" | "redline") => ({
      ...makeBundle(v),
      assetsDir,
    }));
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
    platformDb: { id: pdb, name: pdbName },
    hostsKv: { id: hostsId, title: hostsTitle },
    registryKv: { id: regId, title: regTitle },
    domains: DOMAINS[env],
    bundles,
    patDir,
    brokerEnabled: o.brokerEnabled ?? false,
    fetch: fake.fetch,
    now: clock.now,
    sleep: clock.sleep,
    ...(o.template ? { template: o.template } : {}),
    ...over,
  });
  const mk = (over: Partial<WfpOptions> = {}) => new WfpProvisioner(opts(over));
  const db = () => (fake.d1.get(pdb) as { db: DatabaseSync }).db;
  // biome-ignore lint/suspicious/noExplicitAny: test rows
  const rows = () => db().prepare("SELECT * FROM installs").all() as any[];
  const scriptOf = (id: string) =>
    fake.script(
      target.kind === "namespace" ? target.ns : null,
      `${ENV_PREFIX[env]}${id}`,
    );
  const collect = (id: string) => {
    for (const v of scriptOf(id)?.secrets.values() ?? []) SENSITIVE.add(v);
    for (const f of readdirSync(patDir))
      SENSITIVE.add(readFileSync(join(patDir, f), "utf8").trim());
  };
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
    collect,
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
  ...o,
});

/** Calls other than the pre-flight reads (token check, platform SELECTs, KV gets). */
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
async function failAtHealth(s: ReturnType<typeof setup>, i = input()) {
  s.fake.health = () => ({ ok: false });
  const e = await fails(s.p.create(i));
  s.fake.health = undefined;
  return e;
}

describe("WfpProvisioner.create", () => {
  it("creates every resource named by install id and maps both hosts", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    s.collect(inst.id);
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
    const n = `oa-s-${inst.id}`;
    expect([...s.fake.d1.values()].filter((d) => d.name === n)).toHaveLength(1);
    expect(row.d1_id).toBe(
      [...s.fake.d1.entries()].find(([, d]) => d.name === n)?.[0],
    );
    expect(s.fake.r2.has(n)).toBe(true);
    expect(row.kv_id).toBe(
      [...s.fake.kv.entries()].find(([, k]) => k.title === `${n}-oauth`)?.[0],
    );
    const sc = s.fake.script("oa-staging", n);
    expect(sc).toBeDefined();
    expect(s.fake.kvValues(s.hostsId).get(inst.appHost)).toBe(inst.id);
    expect(s.fake.kvValues(s.hostsId).get(inst.contentHost)).toBe(inst.id);
    expect(s.fake.kvValues(s.hostsId).size).toBe(2);
    // server migrations applied in order, recorded like wrangler
    const idb = s.fake.d1.get(row.d1_id)?.db as DatabaseSync;
    const applied = idb
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(applied).toEqual(SERVER_MIGRATIONS);
    // owner + token row, welcome artifact published and read back
    expect(
      idb.prepare("SELECT role FROM users WHERE email = ?").get(OWNER),
    ).toEqual({ role: "owner" });
    expect(s.fake.artifacts.size).toBe(1);
    expect([...s.fake.artifacts.values()][0]?.title).toMatch(/Welcome/);
    // audit trail
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
    s.collect(inst.id);
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
    s.collect(inst.id);
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
    const inst = await s.p.create(input());
    s.collect(inst.id);
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
    const inst = await s.p.create(input());
    s.collect(inst.id);
    for (const v of before.values()) SENSITIVE.add(v);
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
      s.collect(inst.id);
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
      s.collect(inst.id);
      expect(inst.id).toBe(row.id);
    });

    it("an active slug fails before any Cloudflare write", async () => {
      const s = setup();
      const inst = await s.p.create(input());
      s.collect(inst.id);
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/already exists|active/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });

    it.each([
      ["owner", { ownerEmail: "someone@else.test" }],
      ["vars", { vars: { EMAIL_DAILY_CAP: "5" } }],
      ["testHooks", { testHooks: true, bundle: "redline" as const }],
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
      // 1: fail between the registry add and the secret upload
      s.fake.inject((m, p) => m === "PUT" && p.endsWith("/secrets"), {
        status: 400,
      });
      await fails(s.p.create(input()));
      const [row1] = s.rows();
      const reg = () =>
        JSON.parse(s.fake.kvValues(s.regId).get(row1.id) as string);
      expect(reg().keys).toHaveLength(1);
      expect(row1.broker_kid).toBeNull();
      // 2: fail between the upload and the old-key removal
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
      // 3: heals
      const inst = await s.p.create(input());
      s.collect(inst.id);
      const [row3] = s.rows();
      const entry = reg();
      expect(entry.keys).toHaveLength(1);
      expect(entry.keys[0].kid).toBe(row3.broker_kid);
      expect(brokerKid(entry.keys[0].x)).toBe(entry.keys[0].kid);
      const digest = createHash("sha256")
        .update(Buffer.from(entry.keys[0].x, "base64url"))
        .digest("base64url");
      expect(entry.keys[0].kid).toBe(digest.slice(0, 16));
      // never more than 2 keys in any write
      for (const p of regPuts(s))
        if (p.status === 200)
          expect(JSON.parse(p.body).keys.length).toBeLessThanOrEqual(2);
      // x verifies a signature made with BROKER_SIGNING_KEY
      const sk = s
        .scriptOf(inst.id)
        ?.secrets.get("BROKER_SIGNING_KEY") as string;
      SENSITIVE.add(sk);
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
      s.collect(inst.id);
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
      s.collect(inst.id);
      expect(s.fake.kvValues(s.regId).size).toBe(0);
      expect(s.scriptOf(inst.id)?.secrets.has("BROKER_SIGNING_KEY")).toBe(
        false,
      );
    });

    it("a create whose origin already belongs to another install is refused and writes nothing", async () => {
      const s = setup({ brokerEnabled: true });
      s.db()
        .prepare(
          "INSERT INTO installs (id, slug, app_host, content_host, inputs_hash, state, rl_ns) VALUES ('iaaaaaaaaaaa', 'legacy', 'finqore.open-artifacts-staging.app', 'legacy.open-artifacts-staging.page', 'x', 'active', 1000000)",
        )
        .run();
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(s.fake.writes()).toEqual([]);
      expect(s.fake.kvValues(s.regId).size).toBe(0);
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
        `https://FinQore.open-artifacts-staging.app`,
        `https://${h}.`,
        `https://other.open-artifacts-staging.app`,
      ])
        expect(() => assertBrokerOrigin(bad, h), bad).toThrow(/origin/);
      expect(() => brokerOrigin("FinQore.open-artifacts-staging.app")).toThrow(
        /origin/,
      );
    });
  });

  it("drift test names: BROKER_SIGNING_KEY is a secret binding; BROKER_KID and BROKER_KEY appear nowhere", async () => {
    const s = setup({ brokerEnabled: true });
    const inst = await s.p.create(input());
    s.collect(inst.id);
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
    // every uploaded binding is a known name
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

  describe("bundle variants (decision 8)", () => {
    it("testHooks in oa-prod is refused before any Cloudflare call", async () => {
      const s = setup({ env: "prod" });
      const e = await fails(
        s.p.create(input("finqore", { testHooks: true, bundle: "redline" })),
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
        await fails(s.p.create(input("finqore", { testHooks, bundle })));
        expect(s.fake.log).toEqual([]);
      },
    );

    it("redline on an account target is refused (hooks only in the oa-staging namespace)", async () => {
      const s = setup({ target: { kind: "account" } });
      await fails(
        s.p.create(input("finqore", { testHooks: true, bundle: "redline" })),
      );
      expect(s.fake.log).toEqual([]);
    });

    it.each([
      [
        "a release whose define is true",
        {
          variant: "release",
          define: "true",
          ask: "release",
          hooks: false,
          tamper: false,
        },
      ],
      [
        "a redline asked for, release returned",
        {
          variant: "release",
          define: "false",
          ask: "redline",
          hooks: true,
          tamper: false,
        },
      ],
      [
        "a tampered bundle hash",
        {
          variant: "release",
          define: "false",
          ask: "release",
          hooks: false,
          tamper: true,
        },
      ],
    ])("%s is refused with zero Cloudflare calls", async (_n, c) => {
      const s = setup({
        bundles: async () => {
          const b = makeBundle(c.variant as "release");
          const out = {
            ...b,
            defines: {
              [TEST_HOOKS_DEFINE]: c.define,
            } as HostedBundle["defines"],
          };
          if (c.tamper)
            out.modules = [
              {
                ...out.modules[0],
                bytes: enc("evil"),
              } as HostedBundle["modules"][0],
            ];
          else out.hash = bundleHash(out);
          return out;
        },
      });
      await fails(
        s.p.create(
          input("finqore", { bundle: c.ask as "release", testHooks: c.hooks }),
        ),
      );
      expect(s.fake.log).toEqual([]);
    });

    it("a release upload carries the release bundle (define false) and no hooks flag", async () => {
      const s = setup();
      const inst = await s.p.create(input());
      s.collect(inst.id);
      const sc = s.scriptOf(inst.id);
      const rel = makeBundle("release");
      expect(new TextDecoder().decode(sc?.modules.get("index.js")?.bytes)).toBe(
        new TextDecoder().decode(rel.modules[0]?.bytes),
      );
      expect(rel.defines[TEST_HOOKS_DEFINE]).toBe("false");
      const names = sc?.metadata.bindings.map((b: { name: string }) => b.name);
      expect(names).not.toContain("TEST_HOOKS");
      expect(names).not.toContain("TEST_HOOK_KEY");
      expect(JSON.stringify(sc?.metadata)).not.toMatch(/hook/i);
    });

    it("the two variants differ only in the define, and the hash pins the bytes", () => {
      const a = makeBundle("release");
      const b = makeBundle("redline");
      expect(a.hash).not.toBe(b.hash);
      expect(a.mainModule).toBe(b.mainModule);
      expect(a.version).toBe(b.version);
      expect(bundleHash(a)).toBe(a.hash);
    });
  });

  it("on staging the hook-key file is 0600, matches TEST_HOOK_KEY and never appears in output", async () => {
    const s = setup();
    const inst = await s.p.create(
      input("redqa", { testHooks: true, bundle: "redline" }),
    );
    s.collect(inst.id);
    PRINTABLE.push(JSON.stringify(inst));
    const f = join(s.patDir, "redqa.open-artifacts-staging.app-hook-key");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const key = readFileSync(f, "utf8").trim();
    expect(s.scriptOf(inst.id)?.secrets.get("TEST_HOOK_KEY")).toBe(key);
    expect(s.rows()[0].test_hooks).toBe(1);
    const plain = s
      .scriptOf(inst.id)
      ?.metadata.bindings.find(
        (b: { name: string }) => b.name === "TEST_HOOKS",
      );
    expect(plain).toMatchObject({ type: "plain_text", text: "1" });
    expect(JSON.stringify(inst)).not.toContain(key);
  });

  it("secrets are 48-byte random, differ between two installs, and never appear in the call log's printable fields or thrown errors", async () => {
    const s = setup();
    const a = await s.p.create(input("alpha"));
    const b = await s.p.create(input("beta"));
    s.collect(a.id);
    s.collect(b.id);
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
    }
    expect(new Set(sa.values()).size).toBe(sa.size);
    // Platform rows hold the owner email by design, so they are checked for secrets only.
    const rows = JSON.stringify(s.rows());
    const printable =
      JSON.stringify(s.fake.log) +
      JSON.stringify([a, b]) +
      JSON.stringify(s.p.notes);
    for (const v of [...sa.values(), ...sb.values(), s.fake.token]) {
      expect(printable).not.toContain(v);
      expect(rows).not.toContain(v);
    }
    PRINTABLE.push(printable);
  });

  it("a rerun/resume of the same install does not mint a new SESSION_SECRET", async () => {
    const s = setup();
    await failAtHealth(s);
    const [row] = s.rows();
    const first = s.scriptOf(row.id)?.secrets.get("SESSION_SECRET");
    const inst = await s.p.create(input());
    s.collect(inst.id);
    expect(uploads(s.fake)).toHaveLength(1);
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
    s.collect(inst.id);
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
    const inst = await s.p.create(input());
    s.collect(inst.id);
    const w = s.fake.writes();
    const hostIdx = w.findIndex((x) =>
      x.includes(`/namespaces/${s.hostsId}/values/`),
    );
    const upIdx = w.findIndex((x) => /^PUT .*\/scripts\/[^/]+$/.test(x));
    const brokerIdx = w
      .map((x) => x.includes(`/namespaces/${s.regId}/values/`))
      .lastIndexOf(true);
    expect(brokerIdx).toBeGreaterThan(upIdx);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(hostIdx).toBeGreaterThan(upIdx);
    expect(hostIdx).toBeGreaterThan(brokerIdx);
    // nothing that creates or changes a resource comes after the hosts
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
      s.db()
        .prepare(
          "INSERT INTO installs (id, slug, app_host, content_host, inputs_hash, state, rl_ns) VALUES ('iaaaaaaaaaaa', 'finqore', 'finqore.open-artifacts-staging.app', 'finqore.open-artifacts-staging.page', 'x', 'active', 1000000)",
        )
        .run();
      await fails(s.p.create(input()));
      expect(s.fake.writes()).toEqual([]);
    });
    it("an invalid or reserved slug makes zero calls", async () => {
      const s = setup();
      await fails(s.p.create(input("auth")));
      await fails(s.p.create(input("Bad_Slug")));
      expect(s.fake.log).toEqual([]);
    });
  });

  it("the PAT file is 0600, minted for the owner, and its content never appears in returned values", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    s.collect(inst.id);
    expect(statSync(inst.patFile).mode & 0o777).toBe(0o600);
    const pat = readFileSync(inst.patFile, "utf8").trim();
    expect(isPat(pat)).toBe(true);
    expect(JSON.stringify(inst)).not.toContain(pat);
    expect(JSON.stringify(s.p.notes)).not.toContain(pat);
    const idb = s.fake.d1.get(s.rows()[0].d1_id)?.db as DatabaseSync;
    const hash = createHash("sha256").update(pat).digest("hex");
    expect(
      idb
        .prepare("SELECT revoked_at FROM tokens WHERE token_hash = ?")
        .get(hash),
    ).toEqual({ revoked_at: null });
    // no other place holds the PAT: not the call log, not the platform rows
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
      const inst = await s.p.create(input());
      s.collect(inst.id);
      const ups = uploads(s.fake);
      expect(ups).toHaveLength(1);
      const m = metaOf(ups[0]?.body as string).migrations;
      expect(m.old_tag).toBeUndefined();
      expect(m.new_tag).toBe("v2");
      expect(m.steps).toHaveLength(2);
      expect(s.fake.log.some((e) => e.status === 412)).toBe(false);
      expect(s.rows()[0].do_migration_tag).toBe("v2");
    });

    it("a rerun at the same tag sends no migrations", async () => {
      const s = setup({ template: tpl(["v1", "v2"]) });
      await failAtHealth(s);
      const [row] = s.rows();
      s.scriptOf(row.id)?.secrets.delete("DIRECTORY_TOKEN_KEY");
      const inst = await s.p.create(input());
      s.collect(inst.id);
      const ups = uploads(s.fake);
      expect(ups).toHaveLength(2);
      expect(metaOf(ups[1]?.body as string).migrations).toBeUndefined();
    });

    it("a rerun whose journal is empty probes, learns the live tag and sends nothing when it is current", async () => {
      const s = setup({ template: tpl(["v1", "v2"]) });
      await failAtHealth(s);
      const [row] = s.rows();
      s.db()
        .prepare("UPDATE installs SET do_migration_tag = NULL WHERE id = ?")
        .run(row.id);
      const inst = await s.p.create(input());
      s.collect(inst.id);
      const ups = uploads(s.fake);
      expect(ups.map((u) => u.status)).toEqual([200, 412, 200]);
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
      const inst = await p2.create(input());
      s.collect(inst.id);
      const ups = uploads(s.fake);
      expect(ups.map((u) => u.status)).toEqual([200, 412, 200]);
      const m = metaOf(ups[2]?.body as string).migrations;
      expect(m).toMatchObject({ old_tag: "v2", new_tag: "v3" });
      expect(m.steps).toHaveLength(1);
      expect(s.scriptOf(row.id)?.migrationTag).toBe("v3");
      expect(s.rows()[0].do_migration_tag).toBe("v3");
    });
  });

  describe("assets (decision 6)", () => {
    it("manifest hashes are 32 hex, uploads go to the account assets route with the session jwt, 202 then 201", async () => {
      const s = setup();
      const inst = await s.p.create(input());
      s.collect(inst.id);
      const sess = s.fake.log.findIndex((e) =>
        e.path.endsWith("/assets-upload-session"),
      );
      expect(s.fake.log[sess]?.path).toContain(
        "/workers/dispatch/namespaces/oa-staging/scripts/",
      );
      const manifest = JSON.parse(s.fake.raw[sess]?.body as string).manifest;
      expect(Object.keys(manifest).sort()).toEqual(["/app.js", "/index.html"]);
      for (const v of Object.values(manifest) as {
        hash: string;
        size: number;
      }[]) {
        expect(v.hash).toMatch(/^[0-9a-f]{32}$/);
      }
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
      s.collect(a.id);
      s.collect(b.id);
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

  describe("env-prefixed names (decision 2)", () => {
    it.each([
      [
        "a forged prod platform DB",
        (s: ReturnType<typeof setup>) =>
          s.mk({ platformDb: { id: s.pdb, name: "oa-p-platform" } }),
      ],
      [
        "a platform DB named open-artifacts",
        (s: ReturnType<typeof setup>) =>
          s.mk({ platformDb: { id: s.pdb, name: "open-artifacts" } }),
      ],
      [
        "a HOSTS KV named open-artifacts",
        (s: ReturnType<typeof setup>) =>
          s.mk({ hostsKv: { id: s.hostsId, title: "open-artifacts" } }),
      ],
      [
        "a forged prod registry",
        (s: ReturnType<typeof setup>) =>
          s.mk({
            brokerEnabled: true,
            registryKv: { id: s.regId, title: "oa-p-broker-registry" },
          }),
      ],
    ])(
      "%s throws ForeignResource with zero Cloudflare calls",
      async (_n, make) => {
        const s = setup();
        const e = await fails(make(s).create(input()));
        expect(e).toBeInstanceOf(ForeignResource);
        expect(s.fake.log).toEqual([]);
      },
    );

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

    it("a 403 on the Workers Scripts read is refused before any write", async () => {
      const s = setup();
      s.fake.scriptsReadStatus = 403;
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/Workers Scripts/);
      expect(s.fake.log.map((e) => e.path)).toEqual([
        "/user/tokens/verify",
        `/accounts/${s.fake.accountId}/workers/scripts?per_page=1`,
      ]);
    });

    it("warns when the token expires within 5 days, and never calls a zone, DNS or email API", async () => {
      const s = setup();
      s.fake.tokenInfo.expires_on = new Date(
        NOW + 2 * 86_400_000,
      ).toISOString();
      const inst = await s.p.create(input());
      s.collect(inst.id);
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
      const inst = await p.create(input());
      s.collect(inst.id);
      expect(s.rows()[0].state).toBe("active");
    });
  });
});

describe("cfClient", () => {
  it("retries 429 and 5xx three times and never puts the request body in the error", async () => {
    const fake = new FakeCf();
    SENSITIVE.add(fake.token);
    const cf = cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: fake.fetch,
      sleep: async () => {},
    });
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
    const fake = new FakeCf();
    const cf = cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"), {
      status: 400,
    });
    await fails(cf.r2Create("oa-s-x"));
    expect(fake.log).toHaveLength(1);
  });
});

describe("platform D1 migration (decision 10)", () => {
  const db = () => {
    const d = new DatabaseSync(":memory:");
    for (const s of splitSql(PLATFORM_SQL)) d.exec(s);
    return d;
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
  it("rl_ns must be a multiple of 8 and unique; state is checked", () => {
    const d = db();
    const ins = d.prepare(
      "INSERT INTO installs (id, slug, inputs_hash, rl_ns, state) VALUES (?, ?, 'h', ?, ?)",
    );
    ins.run("i1", "a", 1_000_000, "creating");
    expect(() => ins.run("i2", "b", 1_000_004, "creating")).toThrow();
    expect(() => ins.run("i3", "c", 1_000_000, "creating")).toThrow();
    expect(() => ins.run("i4", "d", 1_000_008, "bogus")).toThrow();
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

afterAll(() => {
  // Not an `it`: runs after every test, so it sees every collected value.
  const haystack = [...THROWN, ...PRINTABLE].join("\n");
  const leaks = [...SENSITIVE].filter(
    (v) => v.length >= 8 && haystack.includes(v),
  );
  if (leaks.length > 0)
    throw new Error(
      `${leaks.length} sensitive value(s) leaked into errors or output`,
    );
});

describe("no secret in any error or printable output", () => {
  it("collected values", () => {
    expect(SENSITIVE.size).toBeGreaterThan(10);
    expect(THROWN.length).toBeGreaterThan(20);
    const haystack = [...THROWN, ...PRINTABLE].join("\n");
    for (const v of SENSITIVE)
      if (v.length >= 8)
        expect(haystack.includes(v), "a sensitive value leaked").toBe(false);
  });
});
