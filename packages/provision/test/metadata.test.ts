import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Binding,
  buildBundle,
  type InstallMetaInput,
  names,
  parseTemplate,
  type ResourceMetaInput,
  TEMPLATE_BINDINGS_EXCLUDED,
  userWorkerMetadata,
} from "../src/index.js";

const TEMPLATE_PATH = new URL(
  "../../../apps/server/wrangler.template.jsonc",
  import.meta.url,
);
const tpl = parseTemplate(await readFile(TEMPLATE_PATH, "utf8"));

const inst = (o: Partial<InstallMetaInput> = {}): InstallMetaInput => ({
  id: "iabcdefghjk2",
  appHost: "a.app.test",
  contentHost: "a.content.test",
  ownerEmail: "o@x.test",
  vars: { EMAIL_FROM: "noreply@a.mail.app.test" },
  testHooks: false,
  ...o,
});
const res = (o: Partial<ResourceMetaInput> = {}): ResourceMetaInput => ({
  d1Id: "d1-id",
  kvId: "kv-id",
  version: "1.2.3",
  rlNs: 2_000_000,
  doMigrationTag: null,
  namespace: "oa-staging",
  mainModule: "index.js",
  secrets: { SESSION_SECRET: "s", CONTENT_SIGNING_KEY: "c" },
  ...o,
});
const text = (b: Binding[], name: string) =>
  b.find((x) => x.name === name && x.type === "plain_text")?.text;

describe("userWorkerMetadata", () => {
  it("every template binding and var is mapped or explicitly excluded", () => {
    const m = userWorkerMetadata(inst(), res({ template: tpl }));
    const have = new Set(m.bindings.map((b) => b.name));
    const want = [
      ...(tpl.browser ? [tpl.browser.binding] : []),
      ...tpl.send_email.map((e: { name: string }) => e.name),
      tpl.assets.binding,
      ...tpl.d1_databases.map((e: { binding: string }) => e.binding),
      ...tpl.r2_buckets.map((e: { binding: string }) => e.binding),
      ...tpl.kv_namespaces.map((e: { binding: string }) => e.binding),
      ...tpl.durable_objects.bindings.map((e: { name: string }) => e.name),
      ...tpl.ratelimits.map((e: { name: string }) => e.name),
      ...Object.keys(tpl.vars),
    ];
    for (const n of want)
      expect(have.has(n) || n in TEMPLATE_BINDINGS_EXCLUDED, n).toBe(true);
    for (const n of Object.keys(TEMPLATE_BINDINGS_EXCLUDED)) {
      expect(have.has(n), `${n} must not be uploaded`).toBe(false);
      if (n !== "ANALYTICS_TOKEN")
        expect(Object.keys(tpl).includes(n) || n in tpl.vars, n).toBe(true);
    }
    // top-level template keys are all known
    const known = new Set([
      "name",
      "main",
      "compatibility_date",
      "compatibility_flags",
      "workers_dev",
      "preview_urls",
      "browser",
      "send_email",
      "assets",
      "routes",
      "d1_databases",
      "r2_buckets",
      "kv_namespaces",
      "durable_objects",
      "migrations",
      "ratelimits",
      "triggers",
      "vars",
      "observability",
    ]);
    for (const k of Object.keys(tpl)) expect(known.has(k), k).toBe(true);
    for (const [, why] of Object.entries(TEMPLATE_BINDINGS_EXCLUDED))
      expect(why.length).toBeGreaterThan(5);
  });

  it("maps binding types exactly", () => {
    const m = userWorkerMetadata(inst(), res());
    const by = (n: string) => m.bindings.find((b) => b.name === n);
    expect(by("DB")).toMatchObject({ type: "d1", id: "d1-id" });
    expect(by("FILES")).toMatchObject({
      type: "r2_bucket",
      bucket_name: names("iabcdefghjk2").r2,
    });
    expect(by("OAUTH_KV")).toMatchObject({
      type: "kv_namespace",
      namespace_id: "kv-id",
    });
    expect(by("ARTIFACT_RUNTIME")).toMatchObject({
      type: "durable_object_namespace",
      class_name: "ArtifactRuntime",
    });
    expect(by("RL_ANON")).toMatchObject({
      type: "ratelimit",
      namespace_id: "2000000",
      simple: { limit: 30, period: 60 },
    });
    expect(by("EMAIL")?.type).toBe("send_email");
    expect(by("BROWSER")?.type).toBe("browser");
    expect(by("ASSETS")?.type).toBe("assets");
    expect(m.assets).toEqual({
      config: {
        not_found_handling: "single-page-application",
        run_worker_first: true,
      },
    });
    expect(m.main_module).toBe("index.js");
    expect(m.compatibility_date).toBe(tpl.compatibility_date);
    expect(m.compatibility_flags).toEqual(tpl.compatibility_flags);
    expect(m.tags).toEqual(["iabcdefghjk2", "v1.2.3"]);
    expect("routes" in m || "triggers" in m).toBe(false);
  });

  it("hosted vars", () => {
    const m = userWorkerMetadata(
      inst({
        vars: {
          EMAIL_FROM: "n@a.test",
          FEATURES: "spaces,directory_sync",
          EMAIL_DAILY_CAP: "50",
          CODE_EMAILS_PER_DAY: "200",
          AUTH_PROVIDERS: "google,email",
          AUTH_DOMAINS: "finqore.com",
          AUTH_BROKER_URL: "https://auth.example.com/x",
          INSTALL_ID: "iabcdefghjk2",
        },
      }),
      res(),
    );
    expect(text(m.bindings, "HOSTED")).toBe("1");
    expect(text(m.bindings, "INSTALL_ID")).toBe("iabcdefghjk2");
    expect(text(m.bindings, "FEATURES")).toBe(
      "spaces,directory_sync,usage_off",
    );
    expect(text(m.bindings, "EMAIL_DAILY_CAP")).toBe("50");
    expect(text(m.bindings, "AUTH_BROKER_URL")).toBe(
      "https://auth.example.com/x",
    );
  });

  it("FEATURES gets usage_off", () => {
    expect(text(userWorkerMetadata(inst(), res()).bindings, "FEATURES")).toBe(
      "usage_off",
    );
    const m = userWorkerMetadata(
      inst({ vars: { EMAIL_FROM: "n@a.test", FEATURES: "usage_off,x" } }),
      res(),
    );
    expect(text(m.bindings, "FEATURES")).toBe("usage_off,x");
  });

  it("unknown or invalid var throws", () => {
    expect(() =>
      userWorkerMetadata(
        inst({ vars: { EMAIL_FROM: "n@a.test", NOPE: "1" } }),
        res(),
      ),
    ).toThrow(/unknown var/);
    expect(() =>
      userWorkerMetadata(
        inst({ vars: { EMAIL_FROM: "n@a.test", HOSTED: "0" } }),
        res(),
      ),
    ).toThrow(/unknown var/);
    expect(() =>
      userWorkerMetadata(
        inst({ vars: { EMAIL_FROM: "n@a.test", EMAIL_DAILY_CAP: "x" } }),
        res(),
      ),
    ).toThrow(/invalid var/);
    expect(() =>
      userWorkerMetadata(
        inst({ vars: { EMAIL_FROM: "n@a.test", INSTALL_ID: "iaaaaaaaaaaa" } }),
        res(),
      ),
    ).toThrow(/INSTALL_ID/);
  });

  it("unfilled placeholder throws", () => {
    expect(() => userWorkerMetadata(inst({ vars: {} }), res())).toThrow(
      /unfilled/,
    );
    const bad = { ...tpl, vars: { ...tpl.vars, EXTRA: "{{NOPE}}" } };
    expect(() => userWorkerMetadata(inst(), res({ template: bad }))).toThrow(
      /unfilled/,
    );
  });

  it("vars carry the install's own hosts", () => {
    const m = userWorkerMetadata(inst(), res());
    expect(text(m.bindings, "APP_HOST")).toBe("a.app.test");
    expect(text(m.bindings, "CONTENT_HOST")).toBe("a.content.test");
    expect(text(m.bindings, "OWNER_EMAIL")).toBe("o@x.test");
    expect(text(m.bindings, "WORKER_NAME")).toBe(names("iabcdefghjk2").script);
    expect(text(m.bindings, "PLAN")).toBe("paid");
    expect(text(m.bindings, "ENVIRONMENT")).toBe("production");
  });

  describe("Durable Object migrations", () => {
    const t2 = {
      ...tpl,
      migrations: [
        { tag: "v1", new_sqlite_classes: ["ArtifactRuntime"] },
        { tag: "v2", new_sqlite_classes: ["DirectorySync"] },
        { tag: "v3", new_sqlite_classes: ["UserPresence"] },
      ],
    };
    it("null sends every tag", () => {
      const m = userWorkerMetadata(inst(), res({ template: t2 }));
      expect(m.migrations).toEqual({
        new_tag: "v3",
        steps: [
          { new_sqlite_classes: ["ArtifactRuntime"] },
          { new_sqlite_classes: ["DirectorySync"] },
          { new_sqlite_classes: ["UserPresence"] },
        ],
      });
    });
    it("a known tag sends only later ones", () => {
      const m = userWorkerMetadata(
        inst(),
        res({ template: t2, doMigrationTag: "v1" }),
      );
      expect(m.migrations).toEqual({
        old_tag: "v1",
        new_tag: "v3",
        steps: [
          { new_sqlite_classes: ["DirectorySync"] },
          { new_sqlite_classes: ["UserPresence"] },
        ],
      });
    });
    it("the latest tag sends none; unknown throws", () => {
      expect(
        userWorkerMetadata(inst(), res({ template: t2, doMigrationTag: "v3" }))
          .migrations,
      ).toBeUndefined();
      expect(() =>
        userWorkerMetadata(inst(), res({ template: t2, doMigrationTag: "v9" })),
      ).toThrow(/unknown/);
    });
  });

  it("each install gets its own ratelimit namespace_id", () => {
    const ids = (rlNs: number) =>
      userWorkerMetadata(inst(), res({ rlNs }))
        .bindings.filter((b) => b.type === "ratelimit")
        .map((b) => b.namespace_id);
    const a = ids(1_000_000);
    const b = ids(1_000_008);
    expect(a.some((x) => b.includes(x))).toBe(false);
    expect(tpl.ratelimits.length).toBeLessThanOrEqual(8);
    for (const e of tpl.ratelimits)
      expect(Number(e.namespace_id)).toBeLessThan(1_000_000);
    const nine = {
      ...tpl,
      ratelimits: Array.from({ length: 9 }, (_, k) => ({
        name: `R${k}`,
        namespace_id: "1",
        simple: { limit: 1, period: 60 },
      })),
    };
    expect(() => userWorkerMetadata(inst(), res({ template: nine }))).toThrow(
      /8/,
    );
    const big = {
      ...tpl,
      ratelimits: [
        {
          name: "R",
          namespace_id: "1000000",
          simple: { limit: 1, period: 60 },
        },
      ],
    };
    expect(() => userWorkerMetadata(inst(), res({ template: big }))).toThrow(
      /1000000/,
    );
  });

  it("test hooks", () => {
    const m = userWorkerMetadata(
      inst({ testHooks: true }),
      res({
        secrets: {
          SESSION_SECRET: "s",
          CONTENT_SIGNING_KEY: "c",
          TEST_HOOK_KEY: "k",
        },
      }),
    );
    expect(text(m.bindings, "TEST_HOOKS")).toBe("1");
    expect(m.bindings.find((b) => b.name === "TEST_HOOK_KEY")).toMatchObject({
      type: "secret_text",
      text: "k",
    });
    expect(m.keep_bindings).toBeUndefined();
    expect(() =>
      userWorkerMetadata(
        inst({ testHooks: true }),
        res({ namespace: "oa-prod" }),
      ),
    ).toThrow(/oa-prod/);
    expect(() =>
      userWorkerMetadata(inst(), res({ secrets: { TEST_HOOK_KEY: "k" } })),
    ).toThrow(/unknown secret/);
  });

  it("later uploads send only missing secrets, with keep_bindings", () => {
    const full = userWorkerMetadata(inst(), res());
    expect(full.keep_bindings).toBeUndefined();
    expect(
      full.bindings
        .filter((b) => b.type === "secret_text")
        .map((b) => b.name)
        .sort(),
    ).toEqual(["CONTENT_SIGNING_KEY", "SESSION_SECRET"]);
    const part = userWorkerMetadata(
      inst(),
      res({ secrets: { CONTENT_SIGNING_KEY: "c" } }),
    );
    expect(
      part.bindings.filter((b) => b.type === "secret_text").map((b) => b.name),
    ).toEqual(["CONTENT_SIGNING_KEY"]);
    expect(part.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(
      userWorkerMetadata(inst(), res({ secrets: {} })).keep_bindings,
    ).toEqual(["secret_text", "secret_key"]);
  });

  it("observability", () => {
    expect(userWorkerMetadata(inst(), res()).observability).toEqual({
      enabled: true,
      logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 },
    });
  });

  it("no secret names appear as plain bindings", () => {
    const m = userWorkerMetadata(inst(), res());
    for (const n of [
      "SESSION_SECRET",
      "CONTENT_SIGNING_KEY",
      "ACCESS_CLIENT_SECRET",
      "ANALYTICS_TOKEN",
    ])
      expect(
        m.bindings.some((b) => b.name === n && b.type !== "secret_text"),
        n,
      ).toBe(false);
    expect(
      m.bindings.some(
        (b) =>
          b.name === "ACCESS_CLIENT_SECRET" || b.name === "ANALYTICS_TOKEN",
      ),
    ).toBe(false);
  });
});

describe("buildBundle", () => {
  it("renders a dummy config, runs wrangler through exec and reads modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "oa-root-"));
    await mkdir(join(root, "apps/server"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "9.8.7" }),
    );
    await writeFile(
      join(root, "apps/server/wrangler.template.jsonc"),
      await readFile(TEMPLATE_PATH),
    );
    const calls: {
      cmd: string;
      args: string[];
      cwd: string;
      config: Record<string, unknown>;
    }[] = [];
    const b = await buildBundle(root, async (cmd, args, o) => {
      const outdir = args[args.indexOf("--outdir") + 1] as string;
      const cfg = args[args.indexOf("-c") + 1] as string;
      calls.push({
        cmd,
        args,
        cwd: o.cwd,
        config: JSON.parse(await readFile(cfg, "utf8")),
      });
      await mkdir(join(outdir, "chunks"), { recursive: true });
      await writeFile(join(outdir, "index.js"), "export default {}");
      await writeFile(join(outdir, "chunks/a.mjs"), "export {}");
      await writeFile(
        join(outdir, "x.wasm"),
        new Uint8Array([0, 97, 115, 109]),
      );
      await writeFile(join(outdir, "README.md"), "no");
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("pnpm");
    expect(calls[0]?.args.slice(0, 6)).toEqual([
      "--dir",
      "apps/server",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
    ]);
    expect(JSON.stringify(calls[0]?.config)).not.toContain("{{");
    expect(calls[0]?.config.routes).toBeUndefined();
    expect(b.mainModule).toBe("index.js");
    expect(b.version).toBe("9.8.7");
    expect(b.assetsDir).toBe("apps/server/dist-assets");
    expect(b.modules.map((m) => [m.name, m.type]).sort()).toEqual([
      ["chunks/a.mjs", "esm"],
      ["index.js", "esm"],
      ["x.wasm", "wasm"],
    ]);
    expect(b.modules.find((m) => m.name === "x.wasm")?.bytes).toEqual(
      new Uint8Array([0, 97, 115, 109]),
    );
  });

  it("throws when wrangler produced no main module", async () => {
    const root = await mkdtemp(join(tmpdir(), "oa-root-"));
    await mkdir(join(root, "apps/server"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    await writeFile(
      join(root, "apps/server/wrangler.template.jsonc"),
      await readFile(TEMPLATE_PATH),
    );
    await expect(buildBundle(root, async () => {})).rejects.toThrow(
      /no index.js/,
    );
  });
});
