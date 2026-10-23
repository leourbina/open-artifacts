// T3b: the CI signer (scripts/ci/sign-release.ts, node:* only) against
// @oa/provision. Its canonicalJson and record builder must produce the same
// bytes; its output must pass publishRelease. The key goes in on stdin only.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as LIB from "../../../scripts/ci/release-artifact.mjs";
import * as PUBKEYS from "../../../scripts/ci/release-pubkeys.mjs";
import { cfClient } from "../src/cf.js";
import { platformNames } from "../src/names.js";
import { canonicalJson } from "../src/platform.js";
import {
  FLOOR_KEY,
  probeR2Conditionals,
  publishRelease,
  r2ReleaseReader,
} from "../src/publish.js";
import {
  assetEntries,
  buildReleaseRecord,
  bundleSha256,
  migrationsSha256,
  openFloor,
  openReleaseRecord,
  TEST_HOOKS_DEFINE,
} from "../src/release.js";
import { FakeCf } from "./fake-cf.js";

const G = vi.hoisted(() => ({
  RELEASE_PUBKEY: { staging: "", prod: "" } as Record<string, string>,
}));
vi.mock("../src/internal/gates.js", async (orig) => {
  const m = await orig<typeof import("../src/internal/gates.js")>();
  return {
    ...m,
    get RELEASE_PUBKEY() {
      return G.RELEASE_PUBKEY;
    },
  };
});

const ROOT = new URL("../../../", import.meta.url).pathname;
// Plain .mjs, run by the runner's own node (no strip-types) in the key jobs.
const SIGN = join(ROOT, "scripts/ci/sign-release.mjs");
const ASSEMBLE = join(ROOT, "scripts/ci/assemble-release.mjs");
const SIGN_FLOOR = join(ROOT, "scripts/ci/sign-floor.mjs");
const CHECK = join(ROOT, "scripts/ci/check-hosted-release.ts");
const enc = (s: string) => new TextEncoder().encode(s);

const KEYS = {
  staging: generateKeyPairSync("ed25519"),
  prod: generateKeyPairSync("ed25519"),
};
const pubX = (k: { publicKey: KeyObject }) =>
  k.publicKey.export({ format: "jwk" }).x as string;
G.RELEASE_PUBKEY = { staging: pubX(KEYS.staging), prod: pubX(KEYS.prod) };
const pem = (env: "staging" | "prod") =>
  KEYS[env].privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const TEMPLATE = new Uint8Array(
  readFileSync(join(ROOT, "apps/server/wrangler.template.jsonc")),
);
const mods = (v: boolean) => [
  {
    name: "index.js",
    type: "esm" as const,
    bytes: enc(
      `const t = true;\nconst hooks = ${v} === true && t;\nexport default {};\n`,
    ),
  },
  {
    name: "chunks/a.wasm",
    type: "wasm" as const,
    bytes: new Uint8Array([0, 97, 115, 109]),
  },
];
const FIX = {
  version: "0.34.0",
  mainModule: "index.js",
  release: mods(false),
  redline: mods(true),
  assets: [
    { path: "index.html", bytes: enc("<p>hi</p>") },
    { path: "assets/app.js", bytes: enc("console.log(1)") },
  ],
  template: TEMPLATE,
  migrations: [{ name: "0000_init.sql", bytes: enc("CREATE TABLE a (x);\n") }],
  welcome: enc("# Welcome\n"),
  built: {
    release: { commit: "", lockfileSha256: "" },
    redline: { commit: "", lockfileSha256: "" },
  },
  // M1: the rendered dry-run configs travel in the artifact.
  configs: {
    release: JSON.stringify({
      main: "src/index.ts",
      define: { [TEST_HOOKS_DEFINE]: "false" },
    }),
    redline: JSON.stringify({
      main: "src/index.ts",
      define: { [TEST_HOOKS_DEFINE]: "true" },
    }),
  },
};
// hosted-guard's commit, and the lockfile the sign job checks out (this repo's).
const GUARD = "a".repeat(40);
const LOCK = join(ROOT, "pnpm-lock.yaml");
const LOCK_SHA = createHash("sha256").update(readFileSync(LOCK)).digest("hex");
FIX.built = {
  release: { commit: GUARD, lockfileSha256: LOCK_SHA },
  redline: { commit: GUARD, lockfileSha256: LOCK_SHA },
};

async function artifact(over: Partial<typeof FIX> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oa-art-"));
  const out = await LIB.writeArtifact(dir, { ...FIX, ...over });
  return { dir, ...out };
}

/**
 * A Node 20 binary to run the key-job scripts under (the runner's preinstalled
 * major): OA_NODE20, else a known local install. Absent: those runs skip and
 * the static post-20 API check (hosted-release.test.ts) still holds.
 */
const NODE20 = [
  process.env.OA_NODE20,
  join(process.env.HOME ?? "", "n/n/versions/node/20.10.0/bin/node"),
  "/opt/homebrew/opt/node@20/bin/node",
].find((p) => {
  if (!p || !existsSync(p)) return false;
  const v = spawnSync(p, ["--version"], { encoding: "utf8" });
  return v.status === 0 && /^v20\./.test(v.stdout);
});

function run(
  script: string,
  args: string[],
  input = "",
  node = process.execPath,
): { code: number | null; stdout: string; stderr: string } {
  // The .ts helpers (check-hosted-release) still need strip-types.
  const flags = script.endsWith(".ts")
    ? ["--experimental-strip-types", "--no-warnings"]
    : [];
  const r = spawnSync(node, [...flags, script, ...args], {
    input,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const outputs = (stdout: string) =>
  Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("=") as [string, string]),
  );

async function signed(
  env: "staging" | "prod" = "staging",
  over: Partial<typeof FIX> = {},
) {
  const a = await artifact(over);
  const check = run(CHECK, [a.dir]);
  expect(check.code, check.stderr).toBe(0);
  const c = outputs(check.stdout);
  const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
  const args = [
    "--dir",
    a.dir,
    "--env",
    env,
    "--version",
    "0.34.0",
    "--manifest-sha256",
    c.manifest_sha256 as string,
    "--bundle-sha256",
    c.bundle_sha256 as string,
    "--commit",
    GUARD,
    "--lockfile",
    LOCK,
    "--out",
    out,
  ];
  const r = run(SIGN, args, pem(env));
  return { a, c, out, args, r, o: outputs(r.stdout) };
}

describe("parity with @oa/provision", () => {
  it("canonicalJson produces identical bytes on fixtures", () => {
    for (const v of [
      { b: 1, a: [3, { d: null, c: 'x "' }], e: true },
      [],
      "s",
      0,
      { "": { z: 1, y: [false] } },
    ])
      expect(LIB.canonicalJson(v)).toBe(canonicalJson(v));
  });

  it("the record builder produces identical bytes on fixtures", () => {
    for (const [env, variant] of [
      ["staging", "release"],
      ["staging", "redline"],
      ["prod", "release"],
    ] as const) {
      const i = {
        env,
        version: FIX.version,
        variant,
        mainModule: FIX.mainModule,
        modules: variant === "redline" ? FIX.redline : FIX.release,
        assets: FIX.assets,
        template: FIX.template,
        migrations: FIX.migrations,
        welcome: FIX.welcome,
      };
      const a = LIB.canonicalJson(LIB.buildRecord(i));
      const b = canonicalJson(buildReleaseRecord(i));
      expect(a).toBe(b);
      expect(JSON.parse(a).defines).toEqual({
        [TEST_HOOKS_DEFINE]: variant === "redline",
      });
    }
    expect(
      LIB.bundleSha256({ mainModule: FIX.mainModule, modules: FIX.release }),
    ).toBe(bundleSha256({ mainModule: FIX.mainModule, modules: FIX.release }));
    expect(LIB.migrationsSha256(FIX.migrations)).toBe(
      migrationsSha256(FIX.migrations),
    );
    expect(LIB.canonicalJson(LIB.assetEntries(FIX.assets))).toBe(
      canonicalJson(assetEntries(FIX.assets)),
    );
  });

  it("the record builder refuses what provision refuses", () => {
    const base = {
      ...FIX,
      env: "staging" as const,
      variant: "release" as const,
      modules: FIX.release,
    };
    for (const bad of [
      { env: "prod" as const, variant: "redline" as const },
      { version: "v1" },
      { assets: [{ path: ".env", bytes: enc("") }] },
      {
        assets: [
          { path: `${"d".repeat(60)}/${"f".repeat(101)}`, bytes: enc("") },
        ],
      },
      {
        assets: [{ path: "big", bytes: new Uint8Array(25 * 1024 * 1024 + 1) }],
      },
    ]) {
      expect(
        () => LIB.buildRecord({ ...base, ...bad }),
        JSON.stringify(Object.keys(bad)),
      ).toThrow();
      expect(() => buildReleaseRecord({ ...base, ...bad })).toThrow();
    }
  });
});

describe("check-hosted-release.ts", () => {
  it("prints the bundleSha256 recomputed from the bytes and the manifest's sha256", async () => {
    const a = await artifact();
    const r = run(CHECK, [a.dir]);
    expect(r.code, r.stderr).toBe(0);
    const o = outputs(r.stdout);
    expect(o.bundle_sha256).toBe(
      bundleSha256({ mainModule: "index.js", modules: FIX.release }),
    );
    expect(o.manifest_sha256).toBe(a.manifestSha256);
  });

  it("refuses a file that does not match manifest.json, an extra file and a symlink", async () => {
    const a = await artifact();
    writeFileSync(join(a.dir, "assets/index.html"), "<p>HI</p>");
    expect(run(CHECK, [a.dir]).code).toBe(1);
    const b = await artifact();
    writeFileSync(join(b.dir, "assets/extra.js"), "x");
    expect(run(CHECK, [b.dir]).code).toBe(1);
    const c = await artifact();
    symlinkSync("/etc/hosts", join(c.dir, "assets/hosts"));
    expect(run(CHECK, [c.dir]).code).toBe(1);
  });
});

describe("sign-release.ts", () => {
  it("staging: signs release and redline, writes the tar and .sig.json, prints only outputs", async () => {
    const s = await signed("staging");
    expect(s.r.code, s.r.stderr).toBe(0);
    expect(readdirSync(s.out).sort()).toEqual([
      "oa-release-staging-redline-0.34.0.sig.json",
      "oa-release-staging-redline-0.34.0.tar",
      "oa-release-staging-release-0.34.0.sig.json",
      "oa-release-staging-release-0.34.0.tar",
    ]);
    expect(Object.keys(s.o).sort()).toEqual([
      "staging_redline_record_sha256",
      "staging_redline_signature",
      "staging_redline_tar_sha256",
      "staging_release_record_sha256",
      "staging_release_signature",
      "staging_release_tar_sha256",
    ]);
    // The key never reaches stdout, stderr or the written files.
    const der = KEYS.staging.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const d = KEYS.staging.privateKey.export({ format: "jwk" }).d as string;
    for (const text of [
      s.r.stdout,
      s.r.stderr,
      ...readdirSync(s.out).map((f) => readFileSync(join(s.out, f), "latin1")),
    ]) {
      expect(text).not.toContain(der.slice(20, 60));
      expect(text).not.toContain(d);
      expect(text).not.toContain("PRIVATE KEY");
    }
    // The .sig.json verifies with provision's reader.
    for (const v of ["release", "redline"] as const) {
      const stored = JSON.parse(
        readFileSync(
          join(s.out, `oa-release-staging-${v}-0.34.0.sig.json`),
          "utf8",
        ),
      );
      const rec = openReleaseRecord(
        stored,
        G.RELEASE_PUBKEY.staging as string,
        "staging",
      );
      expect(rec.variant).toBe(v);
      expect(rec.defines[TEST_HOOKS_DEFINE]).toBe(v === "redline");
      expect(stored.signature).toBe(s.o[`staging_${v}_signature`]);
    }
  });

  it("prod: signs release only", async () => {
    const s = await signed("prod");
    expect(s.r.code, s.r.stderr).toBe(0);
    expect(readdirSync(s.out).sort()).toEqual([
      "oa-release-prod-release-0.34.0.sig.json",
      "oa-release-prod-release-0.34.0.tar",
    ]);
  });

  it("its tar and .sig.json pass publishRelease and read back through r2ReleaseReader", async () => {
    const s = await signed("staging");
    expect(s.r.code, s.r.stderr).toBe(0);
    const fake = new FakeCf();
    fake.r2.add(platformNames("staging").releases);
    const floor = canonicalJson({
      env: "staging",
      seq: 1,
      minVersion: "0.1.0",
      revoked: [],
    });
    const { sign } = await import("node:crypto");
    fake.r2Seed(
      "oa-s-releases",
      FLOOR_KEY,
      enc(
        JSON.stringify({
          record: floor,
          signature: sign(
            null,
            Buffer.from(`oa-release-floor-v1\nstaging\n${floor}`),
            KEYS.staging.privateKey,
          ).toString("base64url"),
        }),
      ),
    );
    const cf = cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    await probeR2Conditionals(cf, "staging");
    for (const v of ["release", "redline"] as const)
      await publishRelease({
        cf,
        env: "staging",
        version: "0.34.0",
        files: {
          tar: new Uint8Array(
            readFileSync(join(s.out, `oa-release-staging-${v}-0.34.0.tar`)),
          ),
          sig: new Uint8Array(
            readFileSync(
              join(s.out, `oa-release-staging-${v}-0.34.0.sig.json`),
            ),
          ),
        },
      });
    const r = r2ReleaseReader(cf, "staging");
    expect(bundleSha256(await r.modules("0.34.0", "redline"))).toBe(
      bundleSha256({ mainModule: "index.js", modules: FIX.redline }),
    );
  });

  it.each<
    [string, (s: Awaited<ReturnType<typeof signed>>) => string[], string]
  >([
    [
      "a manifest sha256 that is not hosted-check's",
      (s) => swap(s.args, "--manifest-sha256", "0".repeat(64)),
      "staging",
    ],
    [
      "a bundle sha256 that is not hosted-check's",
      (s) => swap(s.args, "--bundle-sha256", "0".repeat(64)),
      "staging",
    ],
    [
      "a version other than the manifest's",
      (s) => swap(s.args, "--version", "0.34.1"),
      "staging",
    ],
    ["an unknown env", (s) => swap(s.args, "--env", "dev"), "staging"],
    ["a key in argv", (s) => [...s.args, "--key", "x"], "staging"],
    ["an empty stdin", (s) => s.args, ""],
    ["a non-Ed25519 key", (s) => s.args, "rsa"],
  ])("refuses %s", async (_n, argsOf, keyKind) => {
    const s = await signed("staging");
    const key =
      keyKind === "staging"
        ? pem("staging")
        : keyKind === "rsa"
          ? generateKeyPairSync("rsa", { modulusLength: 2048 })
              .privateKey.export({ format: "pem", type: "pkcs8" })
              .toString()
          : "";
    const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
    const r = run(SIGN, swap(argsOf(s), "--out", out), key);
    expect(r.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
    expect(r.stdout).toBe("");
  });

  it("refuses a file changed after hosted-check (re-hashed against manifest.json)", async () => {
    const s = await signed("staging");
    writeFileSync(join(s.a.dir, "welcome/welcome.md"), "# Evil\n");
    const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
    const r = run(SIGN, swap(s.args, "--out", out), pem("staging"));
    expect(r.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
  });

  // T3b ruling (option 2): the bundles may differ (esbuild tree-shakes the
  // hooks out of release); the configs are compared in hosted-build instead.
  it("signs a redline whose bytes differ from release beyond the define", async () => {
    const red = mods(true);
    red[0] = {
      ...red[0],
      bytes: enc("const hooks = true;\nexport default { hooks };\n"),
    } as (typeof red)[0];
    const s = await signed("staging", { redline: red });
    expect(s.r.code, s.r.stderr).toBe(0);
    for (const v of ["release", "redline"] as const) {
      const stored = JSON.parse(
        readFileSync(
          join(s.out, `oa-release-staging-${v}-0.34.0.sig.json`),
          "utf8",
        ),
      );
      expect(
        openReleaseRecord(stored, G.RELEASE_PUBKEY.staging as string, "staging")
          .defines,
      ).toEqual({
        [TEST_HOOKS_DEFINE]: v === "redline",
      });
    }
  });

  const built = (
    r: Partial<{ commit: string; lockfileSha256: string }>,
    d: Partial<{ commit: string; lockfileSha256: string }>,
  ) => ({
    built: {
      release: { commit: GUARD, lockfileSha256: LOCK_SHA, ...r },
      redline: { commit: GUARD, lockfileSha256: LOCK_SHA, ...d },
    },
  });
  it.each<[string, Partial<typeof FIX>, string[], RegExp]>([
    [
      "release and redline from different commits",
      built({}, { commit: "b".repeat(40) }),
      [],
      /different commits/,
    ],
    [
      "release and redline with different lockfiles",
      built({}, { lockfileSha256: "0".repeat(64) }),
      [],
      /different lockfiles/,
    ],
    [
      "a commit other than hosted-guard's",
      {},
      ["--commit", "c".repeat(40)],
      /hosted-guard/,
    ],
    [
      "both builds from another commit than the guard's",
      built({ commit: "d".repeat(40) }, { commit: "d".repeat(40) }),
      [],
      /hosted-guard/,
    ],
    [
      "a lockfile other than the checked-out one",
      built(
        { lockfileSha256: "1".repeat(64) },
        { lockfileSha256: "1".repeat(64) },
      ),
      [],
      /lockfile/,
    ],
    [
      "a release bundle with a hook route",
      {
        release: [
          {
            name: "index.js",
            type: "esm",
            bytes: enc('app.get("/__test/session", h); const hooks = false;'),
          },
        ],
      },
      [],
      /hook route/,
    ],
    [
      "a release bundle with any other /__test/ string",
      {
        release: [
          {
            name: "index.js",
            type: "esm",
            bytes: enc('app.get("/__test/new-hook", h); const hooks = false;'),
          },
        ],
      },
      [],
      /hook route/,
    ],
  ])("refuses %s", async (_n, over, extra, re) => {
    const a = await artifact(over);
    const ck = run(CHECK, [a.dir]);
    const c =
      ck.code === 0
        ? outputs(ck.stdout)
        : {
            manifest_sha256: a.manifestSha256,
            bundle_sha256: a.bundleSha256.release,
          };
    const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
    const args = [
      "--dir",
      a.dir,
      "--env",
      "staging",
      "--version",
      "0.34.0",
      "--manifest-sha256",
      c.manifest_sha256 as string,
      "--bundle-sha256",
      c.bundle_sha256 as string,
      "--commit",
      GUARD,
      "--lockfile",
      LOCK,
      "--out",
      out,
    ];
    const r = run(
      SIGN,
      extra.length ? swap(args, extra[0] as string, extra[1] as string) : args,
      pem("staging"),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(re);
    expect(readdirSync(out)).toEqual([]);
  });

  it("check-hosted-release refuses a release bundle with a hook route", async () => {
    const a = await artifact({
      release: [
        { name: "index.js", type: "esm", bytes: enc('"/__test/otp/latest"') },
      ],
    });
    const r = run(CHECK, [a.dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/hook route/);
  });

  it("assertSameConfigButDefine: only the define value may differ", () => {
    const cfg = (v: string, extra = {}) =>
      JSON.stringify({
        main: "x",
        define: { [TEST_HOOKS_DEFINE]: v },
        ...extra,
      });
    expect(() =>
      LIB.assertSameConfigButDefine(cfg("false"), cfg("true")),
    ).not.toThrow();
    expect(() =>
      LIB.assertSameConfigButDefine(
        cfg("false"),
        cfg("true", { vars: { A: "1" } }),
      ),
    ).toThrow(/differ/);
    expect(() =>
      LIB.assertSameConfigButDefine(cfg("true"), cfg("false")),
    ).toThrow(/define/);
    expect(() =>
      LIB.assertSameConfigButDefine(cfg("false"), cfg("false")),
    ).toThrow(/define/);
  });
});

describe("assemble-release.ts", () => {
  it("rebuilds the signed files from the artifact and the sign job's outputs, byte-identical", async () => {
    const s = await signed("staging");
    const out = mkdtempSync(join(tmpdir(), "oa-asm-"));
    const pass = (v: string) =>
      `${s.o[`staging_${v}_signature`]}:${s.o[`staging_${v}_tar_sha256`]}:${s.o[`staging_${v}_record_sha256`]}`;
    const r = run(ASSEMBLE, [
      ...swap(s.args, "--out", out),
      "--release",
      pass("release"),
      "--redline",
      pass("redline"),
    ]);
    expect(r.code, r.stderr).toBe(0);
    for (const f of readdirSync(s.out))
      expect(readFileSync(join(out, f)), f).toEqual(
        readFileSync(join(s.out, f)),
      );
  });

  it("refuses a tar or record hash that is not the sign job's", async () => {
    const s = await signed("prod");
    const out = mkdtempSync(join(tmpdir(), "oa-asm-"));
    const r = run(ASSEMBLE, [
      ...swap(s.args, "--out", out),
      "--release",
      `${s.o.prod_release_signature}:${"0".repeat(64)}:${s.o.prod_release_record_sha256}`,
    ]);
    expect(r.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
  });
});

function swap(args: string[], flag: string, value: string): string[] {
  const out = [...args];
  const i = out.indexOf(flag);
  if (i < 0) return [...out, flag, value];
  out[i + 1] = value;
  return out;
}

// ---------- fix round 2 ----------

/** Sign with hosted-check's real outputs for this artifact; returns the run. */
async function signArtifact(
  over: Partial<typeof FIX>,
  env: "staging" | "prod" = "staging",
) {
  const a = await artifact(over);
  const ck = run(CHECK, [a.dir]);
  const c =
    ck.code === 0
      ? outputs(ck.stdout)
      : {
          manifest_sha256: a.manifestSha256,
          bundle_sha256: a.bundleSha256.release,
        };
  const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
  const r = run(
    SIGN,
    [
      "--dir",
      a.dir,
      "--env",
      env,
      "--version",
      "0.34.0",
      "--manifest-sha256",
      c.manifest_sha256 as string,
      "--bundle-sha256",
      c.bundle_sha256 as string,
      "--commit",
      GUARD,
      "--lockfile",
      LOCK,
      "--out",
      out,
    ],
    pem(env),
  );
  return { r, out };
}

describe("M1: defines come from the rendered configs in the artifact", () => {
  const cfg = (v: string, extra = {}) =>
    JSON.stringify({
      main: "src/index.ts",
      define: { [TEST_HOOKS_DEFINE]: v },
      ...extra,
    });
  it("manifest.json covers config/release.json and config/redline.json", async () => {
    const a = await artifact();
    const m = JSON.parse(readFileSync(join(a.dir, "manifest.json"), "utf8"));
    const paths = m.files.map((f: { path: string }) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["config/release.json", "config/redline.json"]),
    );
    writeFileSync(join(a.dir, "config/release.json"), cfg("true"));
    expect(run(CHECK, [a.dir]).code).toBe(1);
  });
  it.each<[string, { release: string; redline: string }, RegExp]>([
    [
      "both variants hooks-on",
      { release: cfg("true"), redline: cfg("true") },
      /define/,
    ],
    [
      "swapped configs",
      { release: cfg("true"), redline: cfg("false") },
      /define/,
    ],
    [
      "configs that differ in another key",
      { release: cfg("false"), redline: cfg("true", { vars: { A: "1" } }) },
      /differ/,
    ],
  ])("refuses %s", async (_n, configs, re) => {
    const { r, out } = await signArtifact({ configs });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(re);
    expect(readdirSync(out)).toEqual([]);
  });
  it("derives defines from the config value: the parsed define, not the label", () => {
    expect(LIB.testHooksOf(cfg("false"))).toBe(false);
    expect(LIB.testHooksOf(cfg("true"))).toBe(true);
    for (const bad of [
      cfg("1"),
      cfg("TRUE"),
      JSON.stringify({ define: {} }),
      "{",
    ])
      expect(() => LIB.testHooksOf(bad), bad).toThrow();
  });
});

describe("L2: the route-policy doc key may appear once across release", () => {
  it("refuses two occurrences", async () => {
    const twice = [
      {
        name: "index.js",
        type: "esm" as const,
        bytes: enc('const a = { "ALL /__test/*": 1 }; const hooks = false;'),
      },
      {
        name: "b.js",
        type: "esm" as const,
        bytes: enc('const b = { "ALL /__test/*": 2 };'),
      },
    ];
    expect(() => LIB.assertNoHookRoutes(twice)).toThrow(/once|ALL/);
    expect(() => LIB.assertNoHookRoutes(twice.slice(0, 1))).not.toThrow();
  });
});

describe("L11: pinned public keys in the node:* copy", () => {
  it("equal gates.ts RELEASE_PUBKEY and its placeholder (parity)", async () => {
    const real = await vi.importActual<
      typeof import("../src/internal/gates.js")
    >("../src/internal/gates.js");
    expect(PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER).toBe(
      real.RELEASE_PUBKEY_PLACEHOLDER,
    );
    expect({ ...PUBKEYS.RELEASE_PUBKEY }).toEqual({ ...real.RELEASE_PUBKEY });
  });
  const x = (e: "staging" | "prod") => pubX(KEYS[e]);
  it("checkSigningKey: refuses a key that is not the pinned one, skips while a placeholder", () => {
    const pinned = { staging: x("staging"), prod: x("prod") };
    expect(PUBKEYS.checkSigningKey("staging", x("staging"), pinned)).toBe(
      "verified",
    );
    expect(() => PUBKEYS.checkSigningKey("prod", x("staging"), pinned)).toThrow(
      /not the pinned/,
    );
    const ph = {
      staging: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
      prod: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
    };
    expect(PUBKEYS.checkSigningKey("prod", x("staging"), ph)).toBe("skipped");
  });
  it("verifySignature: refuses an invalid signature once the key is real, skips while a placeholder", async () => {
    const { sign } = await import("node:crypto");
    const payload = Buffer.from("oa-release-v1\nstaging\n{}");
    const good = sign(null, payload, KEYS.staging.privateKey).toString(
      "base64url",
    );
    const bad = sign(null, payload, KEYS.prod.privateKey).toString("base64url");
    const pinned = { staging: x("staging"), prod: x("prod") };
    expect(PUBKEYS.verifySignature("staging", payload, good, pinned)).toBe(
      "verified",
    );
    expect(() =>
      PUBKEYS.verifySignature("staging", payload, bad, pinned),
    ).toThrow(/does not verify/);
    const ph = {
      staging: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
      prod: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
    };
    expect(PUBKEYS.verifySignature("staging", payload, bad, ph)).toBe(
      "skipped",
    );
  });
  it("assemble logs loudly that it skipped verification while the pubkey is a placeholder", async () => {
    const s = await signed("prod");
    const out = mkdtempSync(join(tmpdir(), "oa-asm-"));
    const r = run(ASSEMBLE, [
      ...swap(s.args, "--out", out),
      "--release",
      `${s.o.prod_release_signature}:${s.o.prod_release_tar_sha256}:${s.o.prod_release_record_sha256}`,
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*placeholder.*NOT verified/);
  });
});

describe("H1: sign-floor.ts", () => {
  const args = (env: string, o: Record<string, string> = {}) => {
    const out = mkdtempSync(join(tmpdir(), "oa-floor-"));
    const a = {
      "--env": env,
      "--seq": "3",
      "--min-version": "0.30.0",
      "--revoked": "0.31.0,0.32.1",
      "--out": out,
      ...o,
    };
    return { out, argv: Object.entries(a).flat() };
  };
  it("signs a floor whose bytes open with provision's openFloor, and prints only outputs", () => {
    const { out, argv } = args("staging");
    const r = run(SIGN_FLOOR, argv, pem("staging"));
    expect(r.code, r.stderr).toBe(0);
    expect(readdirSync(out)).toEqual(["floor-staging-3.sig.json"]);
    const bytes = readFileSync(join(out, "floor-staging-3.sig.json"), "utf8");
    const f = openFloor(JSON.parse(bytes), pubX(KEYS.staging), "staging");
    expect(f).toMatchObject({
      env: "staging",
      seq: 3,
      minVersion: "0.30.0",
      revoked: ["0.31.0", "0.32.1"],
    });
    expect(Object.keys(outputs(r.stdout)).sort()).toEqual([
      "floor_record_sha256",
      "floor_signature",
    ]);
    expect(r.stdout + r.stderr).not.toContain("PRIVATE KEY");
    // An empty revoked list.
    const e = args("prod", { "--revoked": "" });
    expect(run(SIGN_FLOOR, e.argv, pem("prod")).code).toBe(0);
    expect(
      openFloor(
        JSON.parse(readFileSync(join(e.out, "floor-prod-3.sig.json"), "utf8")),
        pubX(KEYS.prod),
        "prod",
      ).revoked,
    ).toEqual([]);
  });
  it("--assemble rebuilds the identical file from the signature and the record sha256, with no key", () => {
    const s = args("staging");
    const r = run(SIGN_FLOOR, s.argv, pem("staging"));
    const o = outputs(r.stdout);
    const a = args("staging");
    const r2 = run(SIGN_FLOOR, [
      ...a.argv,
      "--assemble",
      "--signature",
      o.floor_signature as string,
      "--record-sha256",
      o.floor_record_sha256 as string,
    ]);
    expect(r2.code, r2.stderr).toBe(0);
    expect(readFileSync(join(a.out, "floor-staging-3.sig.json"))).toEqual(
      readFileSync(join(s.out, "floor-staging-3.sig.json")),
    );
    const bad = args("staging", { "--seq": "4" });
    expect(
      run(SIGN_FLOOR, [
        ...bad.argv,
        "--assemble",
        "--signature",
        o.floor_signature as string,
        "--record-sha256",
        o.floor_record_sha256 as string,
      ]).code,
    ).toBe(1);
    expect(readdirSync(bad.out)).toEqual([]);
  });
  it.each<[string, Record<string, string>]>([
    ["seq 0", { "--seq": "0" }],
    ["a non-integer seq", { "--seq": "1.5" }],
    ["a huge seq", { "--seq": "99999999999999999" }],
    ["a non-semver minVersion", { "--min-version": "v1" }],
    ["a non-semver revoked entry", { "--revoked": "0.31.0,latest" }],
    ["a duplicate revoked entry", { "--revoked": "0.31.0,0.31.0" }],
    ["a revoked list with spaces", { "--revoked": "0.31.0, 0.32.0" }],
    ["an unknown env", { "--env": "dev" }],
  ])("refuses %s", (_n, o) => {
    const { out, argv } = args("staging", o);
    const r = run(SIGN_FLOOR, argv, pem("staging"));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(readdirSync(out)).toEqual([]);
  });
  it("refuses a key in argv and an empty stdin", () => {
    const { argv } = args("staging");
    expect(run(SIGN_FLOOR, [...argv, "--key", "x"], pem("staging")).code).toBe(
      1,
    );
    expect(run(SIGN_FLOOR, argv, "").code).toBe(1);
  });
});

// Manager review: the key-job scripts must run on Node 20 (the runner's own
// node, no setup-node). Run the real flows under a Node 20 binary.
// R-L1: the signer-node20 CI job sets OA_REQUIRE_NODE20=1, so a missing
// binary fails there instead of skipping.
it("Node 20: a binary is found when OA_REQUIRE_NODE20=1", () => {
  if (process.env.OA_REQUIRE_NODE20 === "1") expect(NODE20).toBeDefined();
});

describe.skipIf(!NODE20)(`under Node 20 (${NODE20 ?? "none found"})`, () => {
  const n20 = NODE20 as string;
  it("is really Node 20", () => {
    expect(spawnSync(n20, ["--version"], { encoding: "utf8" }).stdout).toMatch(
      /^v20\./,
    );
  });
  it("sign-release.mjs signs staging and assemble-release.mjs rebuilds it", async () => {
    const a = await artifact();
    const c = outputs(run(CHECK, [a.dir]).stdout);
    const out = mkdtempSync(join(tmpdir(), "oa-n20-"));
    const args = [
      "--dir",
      a.dir,
      "--env",
      "staging",
      "--version",
      "0.34.0",
      "--manifest-sha256",
      c.manifest_sha256 as string,
      "--bundle-sha256",
      c.bundle_sha256 as string,
      "--commit",
      GUARD,
      "--lockfile",
      LOCK,
      "--out",
      out,
    ];
    const r = run(SIGN, args, pem("staging"), n20);
    expect(r.code, r.stderr).toBe(0);
    const o = outputs(r.stdout);
    for (const v of ["release", "redline"] as const) {
      const stored = JSON.parse(
        readFileSync(
          join(out, `oa-release-staging-${v}-0.34.0.sig.json`),
          "utf8",
        ),
      );
      expect(
        openReleaseRecord(stored, pubX(KEYS.staging), "staging").variant,
      ).toBe(v);
    }
    const asm = mkdtempSync(join(tmpdir(), "oa-n20-asm-"));
    const pass = (v: string) =>
      `${o[`staging_${v}_signature`]}:${o[`staging_${v}_tar_sha256`]}:${o[`staging_${v}_record_sha256`]}`;
    const r2 = run(
      ASSEMBLE,
      [
        ...swap(args, "--out", asm),
        "--release",
        pass("release"),
        "--redline",
        pass("redline"),
      ],
      "",
      n20,
    );
    expect(r2.code, r2.stderr).toBe(0);
    for (const f of readdirSync(out))
      expect(readFileSync(join(asm, f)), f).toEqual(readFileSync(join(out, f)));
  });
  it("sign-floor.mjs signs and assembles a floor that opens with openFloor", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-n20-floor-"));
    const argv = [
      "--env",
      "prod",
      "--seq",
      "2",
      "--min-version",
      "0.30.0",
      "--revoked",
      "0.31.0",
      "--out",
      out,
    ];
    const r = run(SIGN_FLOOR, argv, pem("prod"), n20);
    expect(r.code, r.stderr).toBe(0);
    const f = openFloor(
      JSON.parse(readFileSync(join(out, "floor-prod-2.sig.json"), "utf8")),
      pubX(KEYS.prod),
      "prod",
    );
    expect(f.seq).toBe(2);
    const o = outputs(r.stdout);
    const out2 = mkdtempSync(join(tmpdir(), "oa-n20-floor-"));
    const r2 = run(
      SIGN_FLOOR,
      [
        ...swap(argv, "--out", out2),
        "--assemble",
        "--signature",
        o.floor_signature as string,
        "--record-sha256",
        o.floor_record_sha256 as string,
      ],
      "",
      n20,
    );
    expect(r2.code, r2.stderr).toBe(0);
    expect(readFileSync(join(out2, "floor-prod-2.sig.json"))).toEqual(
      readFileSync(join(out, "floor-prod-2.sig.json")),
    );
  });
  it("refuses a bad input the same way under Node 20", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-n20-floor-"));
    const r = run(
      SIGN_FLOOR,
      [
        "--env",
        "prod",
        "--seq",
        "0",
        "--min-version",
        "0.30.0",
        "--revoked",
        "",
        "--out",
        out,
      ],
      pem("prod"),
      n20,
    );
    expect(r.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
  });
});
