import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSeed,
  parseArgs,
  run,
  substitute,
  validateManifest,
} from "./publish.js";

const POLL = "P1b2c3d4E5f6g7h8";
const GAL = "G1b2c3d4E5f6g7h8";
const TOKEN = "oa_pat_TOKENTOKENTOKENTOKENTOKENTOKEN12";

const manifest = (over: Record<string, unknown> = {}) => ({
  title: "Live poll",
  visibility: "public",
  allowAnonymousWrites: true,
  capabilities: { db: true, viewer: true },
  description: "d",
  ...over,
});

type Fixture = {
  approved?: string[] | null;
  ids?: Record<string, string>;
  slugs: Record<
    string,
    {
      manifest?: unknown;
      files?: Record<string, string | Buffer>;
      seed?: unknown;
    }
  >;
};
const fixture = (f: Fixture) => {
  const dir = mkdtempSync(join(tmpdir(), "demo-"));
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "seed"), { recursive: true });
  if (f.approved !== null)
    writeFileSync(
      join(dir, "publish.json"),
      JSON.stringify({ approved: f.approved ?? Object.keys(f.slugs) }),
    );
  if (f.ids) writeFileSync(join(dir, "ids.json"), JSON.stringify(f.ids));
  for (const [slug, s] of Object.entries(f.slugs)) {
    mkdirSync(join(dir, "artifacts", slug), { recursive: true });
    writeFileSync(
      join(dir, "artifacts", slug, "manifest.json"),
      JSON.stringify(s.manifest ?? manifest()),
    );
    for (const [p, c] of Object.entries(
      s.files ?? { "index.html": `<p>${slug}</p>` },
    )) {
      mkdirSync(join(dir, "artifacts", slug, p, ".."), { recursive: true });
      writeFileSync(join(dir, "artifacts", slug, p), c);
    }
    if (s.seed !== undefined)
      writeFileSync(join(dir, "seed", `${slug}.json`), JSON.stringify(s.seed));
  }
  const tokenFile = join(dir, "pat");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  return { dir, tokenFile };
};

type Req = { method: string; path: string; body?: string; auth?: string };
type Srv = {
  versions?: Record<string, { version: number; message: string | null }[]>;
  data?: Record<string, Record<string, unknown[]>>;
  live?: Record<string, unknown>;
};
const server = (s: Srv = {}) => {
  const reqs: Req[] = [];
  let n = 0;
  const f = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : "<binary>";
    const auth = (init?.headers as Record<string, string> | undefined)
      ?.authorization;
    reqs.push({ method, path: u.pathname + u.search, body, auth });
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    let m: RegExpMatchArray = "".match(/(?:)/) as RegExpMatchArray;
    const hit = (re: RegExp): boolean => {
      const r = u.pathname.match(re);
      if (r) m = r;
      return r !== null;
    };
    if (method === "GET" && hit(/^\/api\/v1\/artifacts\/([^/]+)\/versions$/))
      return json(s.versions?.[m[1] as string] ?? []);
    if (method === "GET" && hit(/^\/api\/v1\/artifacts\/([^/]+)$/))
      return json(
        s.live?.[m[1] as string] ?? {
          visibility: "public",
          capabilities: { db: true, viewer: true, storage: false },
          allowAnonymousWrites: true,
        },
      );
    if (method === "POST" && u.pathname === "/api/v1/artifacts") {
      const id = `N${++n}b2c3d4E5f6g7h8`;
      return json({ id, version: 1, url: `https://x.test/${id}` });
    }
    if (method === "POST" && hit(/^\/api\/v1\/artifacts\/([^/]+)\/versions$/))
      return json({ id: m[1], version: 2, url: "https://x.test/a" });
    if (
      method === "GET" &&
      hit(/^\/api\/v1\/artifacts\/([^/]+)\/data\/([^/]+)$/)
    )
      return json({
        items: s.data?.[m[1] as string]?.[m[2] as string] ?? [],
        nextCursor: null,
      });
    if (method === "PUT" && u.pathname.endsWith("/data"))
      return json({ ok: true });
    if (method === "POST" && u.pathname === "/api/v1/uploads")
      return json({
        uploadId: "up1",
        artifactId: `U${++n}b2c3d4E5f6g7h8`,
        url: "https://up.test/api/v1/uploads/up1?sig=s&exp=1",
        expiresAt: "x",
      });
    if (method === "PUT" && u.pathname.startsWith("/api/v1/uploads/"))
      return new Response(null, { status: 204 });
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
  return { f, reqs };
};

const exec = async (
  fx: { dir: string; tokenFile: string },
  srv: ReturnType<typeof server>,
  over: Partial<Parameters<typeof run>[0]> = {},
) => {
  const out: string[] = [];
  const code = await run(
    {
      demoDir: fx.dir,
      baseUrl: "https://demo.example.test",
      tokenFile: fx.tokenFile,
      apply: true,
      ...over,
    },
    {},
    (l) => out.push(l),
    srv.f,
  );
  return { code, out, text: out.join("\n") };
};

const publishes = (r: Req[]) =>
  r.filter(
    (x) =>
      x.method === "POST" &&
      (x.path === "/api/v1/artifacts" || x.path.endsWith("/versions")),
  );

describe("validateManifest", () => {
  it("accepts a good manifest", () => {
    expect(validateManifest(manifest())).toEqual([]);
    expect(validateManifest({ title: "t", visibility: "private" })).toEqual([]);
  });
  it("rejects bad visibility, unknown keys, bad title, bad types", () => {
    expect(validateManifest(manifest({ visibility: "world" })).join()).toMatch(
      /visibility/,
    );
    expect(validateManifest(manifest({ extra: 1 })).join()).toMatch(/extra/);
    expect(validateManifest(manifest({ reset: "no" })).join()).toMatch(/reset/);
    expect(validateManifest(manifest({ reset: false }))).toEqual([]);
    expect(validateManifest(manifest({ reset: true }))).toEqual([]);
    expect(validateManifest(manifest({ title: "" })).join()).toMatch(/title/);
    expect(
      validateManifest(manifest({ title: "x".repeat(201) })).join(),
    ).toMatch(/title/);
    expect(
      validateManifest(manifest({ capabilities: { db: 1 } })).join(),
    ).toMatch(/capabilities/);
    expect(
      validateManifest(manifest({ capabilities: { nope: true } })).join(),
    ).toMatch(/capabilities/);
    expect(validateManifest("x").length).toBeGreaterThan(0);
  });
});

describe("substitute", () => {
  const ids = { poll: POLL };
  it("replaces known approved slugs and leaves the rest", () => {
    expect(
      substitute("a {{id:poll}} b {{id:ghost}} {{id:other}}", ids, ["poll"]),
    ).toBe(`a ${POLL} b {{id:ghost}} {{id:other}}`);
  });
  it("leaves an id that is not approved untouched", () => {
    expect(substitute("{{id:poll}}", ids, [])).toBe("{{id:poll}}");
  });
});

describe("parseArgs", () => {
  it("requires https and a base url", () => {
    expect(() => parseArgs([], {})).toThrow(/base-url/);
    expect(() => parseArgs(["--base-url", "http://a.com"], {})).toThrow(
      /https/,
    );
    expect(
      parseArgs(["--base-url", "https://a.com/x", "--token-file", "t"], {}),
    ).toMatchObject({ baseUrl: "https://a.com", apply: false });
    expect(() =>
      parseArgs(["--base-url", "https://a.com", "--tok"], {}),
    ).toThrow(/unknown option/);
  });
});

describe("run: publishing", () => {
  it("is a dry run by default: no network, no token needed", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const s = server();
    const r = await exec(fx, s, { apply: false, tokenFile: undefined });
    expect(r.code).toBe(0);
    expect(s.reqs).toEqual([]);
    expect(r.text).toContain("would publish poll");
  });

  it("publishes only approved slugs", async () => {
    const fx = fixture({
      approved: ["poll"],
      ids: { poll: POLL, secret: "S1b2c3d4E5f6g7h8" },
      slugs: { poll: {}, secret: {} },
    });
    const s = server();
    const r = await exec(fx, s);
    expect(r.code).toBe(0);
    const p = publishes(s.reqs);
    expect(p).toHaveLength(1);
    expect(p[0]?.path).toBe(`/api/v1/artifacts/${POLL}/versions`);
    expect(s.reqs.some((x) => x.path.includes("S1b2c3d4"))).toBe(false);
  });

  it("sends the files, entry, manifest fields and a src: hash message", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const s = server();
    await exec(fx, s);
    const body = JSON.parse(publishes(s.reqs)[0]?.body as string);
    expect(body).toMatchObject({
      title: "Live poll",
      description: "d",
      visibility: "public",
      allowAnonymousWrites: true,
      capabilities: { db: true, viewer: true },
      format: "html",
      entry: "index.html",
      files: { "index.html": "<p>poll</p>" },
    });
    expect(body.message).toMatch(/^src:[0-9a-f]{64}$/);
  });

  it("skips a slug whose content hash equals the current version", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const first = server();
    await exec(fx, first);
    const message = JSON.parse(publishes(first.reqs)[0]?.body as string)
      .message as string;
    const s = server({ versions: { [POLL]: [{ version: 3, message }] } });
    const r = await exec(fx, s);
    expect(r.code).toBe(0);
    expect(publishes(s.reqs)).toEqual([]);
    expect(r.text).toContain("unchanged poll");
    // Changed content publishes again.
    writeFileSync(join(fx.dir, "artifacts/poll/index.html"), "<p>changed</p>");
    const s2 = server({ versions: { [POLL]: [{ version: 3, message }] } });
    await exec(fx, s2);
    expect(publishes(s2.reqs)).toHaveLength(1);
  });

  it("a new slug is created, prints NEW and fails with the instruction", async () => {
    const fx = fixture({ slugs: { poll: {} } });
    const s = server();
    const r = await exec(fx, s, { create: true });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/NEW poll N1b2c3d4E5f6g7h8/);
    expect(r.text).toContain("commit ids.json");
    expect(publishes(s.reqs)[0]?.path).toBe("/api/v1/artifacts");
  });

  it("without create, a slug with no id fails fast before any request", async () => {
    const fx = fixture({
      ids: { gallery: GAL },
      slugs: { poll: {}, gallery: {} },
    });
    const s = server();
    const r = await exec(fx, s);
    expect(r.code).toBe(1);
    expect(r.text).toContain(
      "slug poll has no id; run Demo publish with create=true, then commit ids.json",
    );
    expect(s.reqs).toEqual([]);
  });

  it("sends explicit values for every capability and allowAnonymousWrites", async () => {
    const fx = fixture({
      ids: { poll: POLL },
      slugs: {
        poll: {
          manifest: {
            title: "t",
            visibility: "private",
            capabilities: { db: true },
          },
        },
      },
    });
    const s = server();
    await exec(fx, s);
    const body = JSON.parse(publishes(s.reqs)[0]?.body as string);
    expect(body.capabilities).toEqual({
      db: true,
      viewer: false,
      storage: false,
    });
    expect(body.allowAnonymousWrites).toBe(false);
    expect(body.visibility).toBe("private");
  });

  it("republishes unchanged content when the live settings differ", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const first = server();
    await exec(fx, first);
    const message = JSON.parse(
      publishes(first.reqs)[0]?.body as string,
    ).message;
    const versions = { [POLL]: [{ version: 3, message }] };
    for (const live of [
      {
        visibility: "private",
        capabilities: { db: true, viewer: true, storage: false },
        allowAnonymousWrites: true,
      },
      {
        visibility: "public",
        capabilities: { db: true, viewer: false, storage: false },
        allowAnonymousWrites: true,
      },
      {
        visibility: "public",
        capabilities: { db: true, viewer: true, storage: false },
        allowAnonymousWrites: false,
      },
    ]) {
      const s = server({ versions, live: { [POLL]: live } });
      await exec(fx, s);
      expect(publishes(s.reqs), JSON.stringify(live)).toHaveLength(1);
    }
    const same = server({ versions });
    await exec(fx, same);
    expect(publishes(same.reqs)).toEqual([]);
  });

  it("includes the manifest settings in the content hash", async () => {
    const a = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const b = fixture({
      ids: { poll: POLL },
      slugs: { poll: { manifest: manifest({ allowAnonymousWrites: false }) } },
    });
    const sa = server();
    const sb = server();
    await exec(a, sa);
    await exec(b, sb);
    expect(JSON.parse(publishes(sa.reqs)[0]?.body as string).message).not.toBe(
      JSON.parse(publishes(sb.reqs)[0]?.body as string).message,
    );
  });

  it("a missing publish.json means nothing is approved: publish and --write-seed succeed", async () => {
    const fx = fixture({
      approved: null,
      ids: { poll: POLL },
      slugs: { poll: {} },
    });
    const s = server();
    const r = await exec(fx, s);
    expect(r.code).toBe(0);
    expect(s.reqs).toEqual([]);
    const out = join(fx.dir, "seed-out.json");
    expect(
      await run(
        { demoDir: fx.dir, baseUrl: "", apply: false, writeSeed: out },
        {},
        () => {},
      ),
    ).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({});
  });

  it("refuses a symlinked slug folder, a symlinked file and a symlinked artifacts dir", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: {}, real: {} } });
    // slug folder is a symlink
    const dir2 = fixture({ ids: { poll: POLL }, slugs: { other: {} } }).dir;
    symlinkSync(join(dir2, "artifacts/other"), join(fx.dir, "artifacts/link"));
    writeFileSync(join(fx.dir, "publish.json"), '{"approved":["link"]}');
    const s = server();
    const r = await exec(fx, s);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/link.*symlink/);
    expect(s.reqs).toEqual([]);
    // a symlinked file inside a slug
    const fx2 = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    symlinkSync("/etc/hosts", join(fx2.dir, "artifacts/poll/hosts.txt"));
    const r2 = await exec(fx2, server());
    expect(r2.code).toBe(1);
    expect(r2.text).toMatch(/symlink/);
    // a symlinked artifacts directory
    const fx3 = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const target = fixture({ slugs: { poll: {} } }).dir;
    const { renameSync, rmSync } = await import("node:fs");
    renameSync(join(fx3.dir, "artifacts"), join(fx3.dir, "artifacts-real"));
    symlinkSync(join(target, "artifacts"), join(fx3.dir, "artifacts"));
    const r3 = await exec(fx3, server());
    expect(r3.code).toBe(1);
    expect(r3.text).toMatch(/symlink/);
    rmSync(join(fx3.dir, "artifacts"));
  });

  it("skips dotfiles and dot directories", async () => {
    const fx = fixture({
      ids: { poll: POLL },
      slugs: {
        poll: {
          files: {
            "index.html": "<p>x</p>",
            ".env": "SECRET=1",
            ".git/config": "x",
            "sub/.hidden": "y",
            "sub/ok.txt": "z",
          },
        },
      },
    });
    const s = server();
    await exec(fx, s);
    const body = JSON.parse(publishes(s.reqs)[0]?.body as string);
    expect(Object.keys(body.files).sort()).toEqual([
      "index.html",
      "sub/ok.txt",
    ]);
  });

  it("an invalid manifest fails the run before any publish", async () => {
    const fx = fixture({
      ids: { poll: POLL, ok: GAL },
      slugs: { poll: { manifest: manifest({ visibility: "x" }) }, ok: {} },
    });
    const s = server();
    const r = await exec(fx, s);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/poll.*visibility/);
    expect(publishes(s.reqs)).toEqual([]);
  });

  it("an approved slug with no directory fails the run", async () => {
    const fx = fixture({ approved: ["poll", "ghost"], slugs: { poll: {} } });
    const r = await exec(fx, server());
    expect(r.code).toBe(1);
    expect(r.text).toContain("ghost");
  });

  it("publishes gallery last and substitutes ids into its hash and files", async () => {
    const fx = fixture({
      approved: ["gallery", "poll"],
      ids: { poll: POLL, gallery: GAL },
      slugs: {
        gallery: {
          files: { "index.html": "<a href='/{{id:poll}}'>{{id:nope}}" },
        },
        poll: {},
      },
    });
    const s = server();
    await exec(fx, s);
    const p = publishes(s.reqs);
    expect(p.map((x) => x.path)).toEqual([
      `/api/v1/artifacts/${POLL}/versions`,
      `/api/v1/artifacts/${GAL}/versions`,
    ]);
    const g = JSON.parse(p[1]?.body as string);
    expect(g.files["index.html"]).toBe(`<a href='/${POLL}'>{{id:nope}}`);
    // The hash changes when a new id appears.
    const fx2 = fixture({
      approved: ["gallery", "poll"],
      ids: { gallery: GAL },
      slugs: {
        gallery: {
          files: { "index.html": "<a href='/{{id:poll}}'>{{id:nope}}" },
        },
        poll: {},
      },
    });
    const s2 = server();
    await exec(fx2, s2, { create: true });
    const g2 = publishes(s2.reqs).find((x) => x.path.includes(GAL));
    expect(JSON.parse(g2?.body as string).message).not.toBe(g.message);
  });

  describe("{{origin}}", () => {
    const pub = async (
      files: Record<string, string>,
      baseUrl: string,
      seed?: unknown,
    ) => {
      const fx = fixture({
        ids: { poll: POLL },
        slugs: {
          poll: {
            files,
            seed,
            manifest: manifest({ description: "see {{origin}}" }),
          },
        },
      });
      const s = server();
      await exec(fx, s, { baseUrl });
      return JSON.parse(publishes(s.reqs)[0]?.body as string);
    };
    it("is replaced in index.html and other text files", async () => {
      const b = await pub(
        {
          "index.html": "<a href='{{origin}}/x'>{{origin}}</a>",
          "app.js": "const o='{{origin}}';",
        },
        "https://demo.example.test",
      );
      expect(b.files["index.html"]).toBe(
        "<a href='https://demo.example.test/x'>https://demo.example.test</a>",
      );
      expect(b.files["app.js"]).toBe("const o='https://demo.example.test';");
    });
    it("is not replaced in manifest.json (settings) or seeds", async () => {
      const b = await pub(
        { "index.html": "<p>{{origin}}</p>" },
        "https://demo.example.test",
        { collections: { c: { d: { u: "{{origin}}" } } } },
      );
      expect(b.description).toBe("see {{origin}}");
      expect(b.files["manifest.json"]).toBeUndefined();
      const seeds = buildSeed(
        fixture({
          ids: { poll: POLL },
          slugs: {
            poll: { seed: { collections: { c: { d: { u: "{{origin}}" } } } } },
          },
        }).dir,
      );
      expect(JSON.stringify(seeds)).toContain("{{origin}}");
    });
    it("normalizes a base url with a path or trailing slash", async () => {
      for (const base of [
        "https://demo.example.test/",
        "https://demo.example.test/a/b?x=1",
      ]) {
        const b = await pub({ "index.html": "{{origin}}|" }, base);
        expect(b.files["index.html"]).toBe("https://demo.example.test|");
      }
    });
    it("only matches the exact spelling", async () => {
      const b = await pub(
        { "index.html": "{{ origin }} {{Origin}} {{origin }}" },
        "https://demo.example.test",
      );
      expect(b.files["index.html"]).toBe("{{ origin }} {{Origin}} {{origin }}");
    });
    it("changes the content hash when the origin changes", async () => {
      const a = await pub(
        { "index.html": "{{origin}}" },
        "https://a.example.test",
      );
      const c = await pub(
        { "index.html": "{{origin}}" },
        "https://b.example.test",
      );
      expect(a.message).not.toBe(c.message);
      const a2 = await pub(
        { "index.html": "{{origin}}" },
        "https://a.example.test/",
      );
      expect(a2.message).toBe(a.message);
    });
  });

  it("uploads large files and references them by uploadId", async () => {
    const big = Buffer.alloc(200 * 1024, 97);
    const fx = fixture({
      ids: { poll: POLL },
      slugs: { poll: { files: { "index.html": "<p>x</p>", "big.bin": big } } },
    });
    const s = server();
    const r = await exec(fx, s);
    expect(r.code).toBe(0);
    expect(s.reqs.some((x) => x.path === "/api/v1/uploads")).toBe(true);
    expect(s.reqs.some((x) => x.path.startsWith("/api/v1/uploads/up1"))).toBe(
      true,
    );
    const body = JSON.parse(publishes(s.reqs).at(-1)?.body as string);
    expect(body.files["big.bin"]).toEqual({ uploadId: "up1" });
  });
});

describe("run: seeding", () => {
  const seed = { artifact: "poll", collections: { game: { game: { a: 1 } } } };
  const seedPuts = (r: Req[]) =>
    r.filter((x) => x.method === "PUT" && x.path.endsWith("/data"));
  it("seeds an artifact created in this run", async () => {
    const fx = fixture({ slugs: { poll: { seed } } });
    const s = server();
    await exec(fx, s, { create: true });
    const put = seedPuts(s.reqs);
    expect(put).toHaveLength(1);
    expect(put[0]?.path).toBe("/api/v1/artifacts/N1b2c3d4E5f6g7h8/data");
    expect(JSON.parse(put[0]?.body as string)).toEqual({
      collections: seed.collections,
    });
  });
  it("never seeds an existing artifact, empty or not", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: { seed } } });
    for (const data of [undefined, { [POLL]: { game: [{ id: "game" }] } }]) {
      const s = server({ data });
      await exec(fx, s);
      expect(seedPuts(s.reqs)).toEqual([]);
      expect(s.reqs.some((x) => x.path.includes("/data/"))).toBe(false);
    }
  });
  it("does not seed a new slug with no collections", async () => {
    const fx = fixture({
      slugs: { poll: { seed: { artifact: "poll", collections: {} } } },
    });
    const s = server();
    await exec(fx, s, { create: true });
    expect(seedPuts(s.reqs)).toEqual([]);
  });
});

describe("buildSeed (the one source for the reset)", () => {
  const noDb = { title: "t", visibility: "public" };
  it("keys seeds by id, and emits empty collections for db slugs with no seed", () => {
    const fx = fixture({
      approved: ["poll", "ttt", "gallery", "noid", "nodb"],
      ids: {
        poll: POLL,
        ttt: GAL,
        gallery: "H1b2c3d4E5f6g7h8",
        nodb: "K1b2c3d4E5f6g7h8",
      },
      slugs: {
        poll: { seed: { collections: {} } },
        ttt: {
          seed: { artifact: "ttt", collections: { game: { game: { x: 1 } } } },
        },
        gallery: { manifest: noDb },
        noid: {},
        nodb: { manifest: noDb, seed: { collections: { c: { d: 1 } } } },
      },
    });
    expect(buildSeed(fx.dir)).toEqual({
      [POLL]: { collections: {} },
      [GAL]: { collections: { game: { game: { x: 1 } } } },
      K1b2c3d4E5f6g7h8: { collections: { c: { d: 1 } } },
    });
  });
  it("emits empty collections for a db slug with no seed file at all", () => {
    const fx = fixture({
      ids: { poll: POLL },
      slugs: { poll: {} },
    });
    expect(buildSeed(fx.dir)).toEqual({ [POLL]: { collections: {} } });
  });
  it("refuses a symlinked seed/ directory, in buildSeed and in publish", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const real = join(fx.dir, "seed-real");
    const { renameSync } = await import("node:fs");
    renameSync(join(fx.dir, "seed"), real);
    symlinkSync(real, join(fx.dir, "seed"));
    expect(() => buildSeed(fx.dir)).toThrow(/seed.*symlink/);
    const r = await exec(fx, server(), { create: true });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/seed.*symlink/);
  });
  it("applies publish's checks: symlinked slug folder or manifest, invalid manifest", () => {
    const other = fixture({ slugs: { other: {} } }).dir;
    const a = fixture({ ids: { link: POLL }, slugs: { poll: {} } });
    symlinkSync(join(other, "artifacts/other"), join(a.dir, "artifacts/link"));
    writeFileSync(join(a.dir, "publish.json"), '{"approved":["link"]}');
    expect(() => buildSeed(a.dir)).toThrow(/symlink/);
    const b = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    rmSync(join(b.dir, "artifacts/poll/manifest.json"));
    symlinkSync(
      join(other, "artifacts/other/manifest.json"),
      join(b.dir, "artifacts/poll/manifest.json"),
    );
    expect(() => buildSeed(b.dir)).toThrow(/symlink/);
    const c = fixture({
      ids: { poll: POLL },
      slugs: { poll: { manifest: manifest({ visibility: "x" }) } },
    });
    expect(() => buildSeed(c.dir)).toThrow(/visibility/);
  });
  it("skips slugs whose manifest has reset: false (e.g. the dashboard), even with a seed", () => {
    const fx = fixture({
      approved: ["dashboard", "poll", "keep"],
      ids: { dashboard: GAL, poll: POLL, keep: "K1b2c3d4E5f6g7h8" },
      slugs: {
        dashboard: {
          manifest: manifest({ reset: false }),
          seed: { collections: { stats: { today: { a: 1 } } } },
        },
        poll: {},
        keep: { manifest: manifest({ reset: true }) },
      },
    });
    expect(Object.keys(buildSeed(fx.dir)).sort()).toEqual(
      [POLL, "K1b2c3d4E5f6g7h8"].sort(),
    );
  });
  it("is empty when nothing is approved", () => {
    expect(buildSeed(fixture({ approved: null, slugs: {} }).dir)).toEqual({});
  });
});

describe("token handling", () => {
  it("never appears in output or argv, only in the Authorization header", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const s = server();
    const r = await exec(fx, s);
    expect(r.text).not.toContain(TOKEN);
    expect(
      s.reqs.every((x) => x.auth === undefined || x.auth === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(s.reqs.some((x) => x.auth)).toBe(true);
    expect(
      JSON.stringify(
        parseArgs(["--base-url", "https://a.com", "--token-file", "f"], {}),
      ),
    ).not.toContain(TOKEN);
    expect(readFileSync(fx.tokenFile, "utf8")).toContain(TOKEN);
  });
  it("is scrubbed from error text", async () => {
    const fx = fixture({ ids: { poll: POLL }, slugs: { poll: {} } });
    const out: string[] = [];
    const bad = (async () =>
      new Response(`echo ${TOKEN}`, { status: 500 })) as typeof fetch;
    const code = await run(
      {
        demoDir: fx.dir,
        baseUrl: "https://demo.example.test",
        tokenFile: fx.tokenFile,
        apply: true,
      },
      {},
      (l) => out.push(l),
      bad,
    );
    expect(code).toBe(1);
    expect(out.join("\n")).not.toContain(TOKEN);
  });
});
