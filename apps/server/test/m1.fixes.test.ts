import { env } from "cloudflare:workers";
import { VERSIONS_PAGE_SIZE, VersionInfoSchema } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeAssets } from "./assets-stub.js";
import { errOf, login } from "./helpers.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const E = { ...(env as object), ASSETS: fakeAssets().fetcher } as never;
const APP = "http://app.localhost";

function call(url: string, cookie: string | null, init: RequestInit = {}) {
  const h = new Headers(init.headers);
  if (cookie) h.set("cookie", cookie);
  if (init.method && init.method !== "GET") h.set("x-oa-request", "1");
  if (typeof init.body === "string") h.set("content-type", "application/json");
  return worker.fetch(
    new Request(url, { ...init, headers: h }) as never,
    E,
    ctx,
  );
}

let owner: string;
let ownerId: string;
beforeAll(async () => {
  ({ cookie: owner, userId: ownerId } = await login("m1fix@x.com"));
});

async function publish(files: Record<string, string>, id?: string) {
  const r = await call(
    `${APP}/api/v1/artifacts${id ? `/${id}/versions` : ""}`,
    owner,
    {
      method: "POST",
      body: JSON.stringify(id ? { files } : { title: "t", files }),
    },
  );
  return r;
}
async function create(files: Record<string, string>) {
  const r = await publish(files);
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
async function contentUrl(id: string, v?: number) {
  const r = await call(
    `${APP}/api/v1/artifacts/${id}/content-url${v ? `?v=${v}` : ""}`,
    owner,
  );
  return ((await r.json()) as { url: string }).url;
}
async function versions(id: string, before?: number) {
  const r = await call(
    `${APP}/api/v1/artifacts/${id}/versions${before ? `?before=${before}` : ""}`,
    owner,
  );
  expect(r.status).toBe(200);
  const text = await r.text();
  return { text, list: VersionInfoSchema.array().parse(JSON.parse(text)) };
}

describe("per-version format", () => {
  it("VersionInfo carries each version's format; restore copies it", async () => {
    const id = await create({ "README.md": "# hi" });
    expect((await publish({ "index.html": "<p>x</p>" }, id)).status).toBe(201);
    const r = await call(
      `${APP}/api/v1/artifacts/${id}/versions/1/restore`,
      owner,
      {
        method: "POST",
      },
    );
    expect(r.status).toBe(201);
    const { list } = await versions(id);
    expect(list.map((v) => [v.version, v.format])).toEqual([
      [3, "markdown"],
      [2, "html"],
      [1, "markdown"],
    ]);
    const s = await call(`${APP}/api/v1/artifacts/${id}`, owner);
    expect(((await s.json()) as { format: string }).format).toBe("markdown");
  });

  it("a null version format (pre-migration row) falls back to the artifact's", async () => {
    const id = await create({ "README.md": "# legacy" });
    await env.DB.prepare(
      "update versions set format = null where artifact_id = ?",
    )
      .bind(id)
      .run();
    const { list } = await versions(id);
    expect(list[0]?.format).toBe("markdown");
    const view = await call(await contentUrl(id), null);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain('name="oa-format" content="markdown"');
  });

  it("migration 0002 backfills from the artifact; CHECK rejects unknown formats", async () => {
    const migs = (
      env as unknown as {
        TEST_MIGRATIONS: { name: string; queries: string[] }[];
      }
    ).TEST_MIGRATIONS;
    const m = migs.find((x) => x.name.startsWith("0002_"));
    const sql = m?.queries.join("\n") ?? "";
    expect(sql).toMatch(/ALTER TABLE `versions` ADD `format` text/);
    expect(sql).toMatch(
      /UPDATE versions SET format = \(SELECT format FROM artifacts a WHERE a\.id = versions\.artifact_id\) WHERE format IS NULL/,
    );
    await expect(
      env.DB.prepare(
        "update versions set format = 'doc' where rowid = (select min(rowid) from versions)",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("listVersions byte budget", () => {
  it("20 big manifests → a short page under 2 MB; paging continues", async () => {
    const id = await create({ "index.html": "x" });
    // 20 more versions, each 1000 entries with 512-char paths (~575 KB of manifest).
    for (let v = 2; v <= 21; v++)
      await env.DB.prepare(
        `insert into versions (artifact_id, version, entry, manifest, format, created_by, created_at)
         with recursive n(i) as (select 1 union all select i + 1 from n where i < 1000)
         select ?, ?, 'index.html',
           (select json_group_array(json_object('path',
               substr(printf('%04d', i) || replace(hex(zeroblob(256)), '0', 'a'), 1, 512),
               'key', 'k', 'size', 1, 'contentType', 'text/plain')) from n),
           'html', ?, ?`,
      )
        .bind(id, v, ownerId, Date.now())
        .run();
    await env.DB.prepare(
      "update artifacts set current_version = 21 where id = ?",
    )
      .bind(id)
      .run();
    const first = await versions(id);
    expect(first.list.length).toBeGreaterThanOrEqual(1);
    expect(first.list.length).toBeLessThan(VERSIONS_PAGE_SIZE);
    expect(first.text.length).toBeLessThan(2 * 1024 * 1024);
    expect(first.list[0]?.version).toBe(21);
    let seen = first.list.length;
    let before = first.list.at(-1)?.version;
    for (let guard = 0; guard < 40 && before; guard++) {
      const p = await versions(id, before);
      if (!p.list.length) break;
      expect(p.text.length).toBeLessThan(2 * 1024 * 1024);
      seen += p.list.length;
      before = p.list.at(-1)?.version;
    }
    expect(seen).toBe(21);
  });

  it("small manifests still page at 20", async () => {
    const id = await create({ "index.html": "1" });
    for (let i = 2; i <= 22; i++)
      expect((await publish({ "index.html": String(i) }, id)).status).toBe(201);
    expect((await versions(id)).list.length).toBe(VERSIONS_PAGE_SIZE);
  });
});

describe("path edge cases", () => {
  for (const p of ["%2e%2e/x", "a/%2E/b", "a%2fb", "__view", "./__view"])
    it(`publish rejects ${JSON.stringify(p)} with 400`, async () => {
      const r = await publish({ "index.html": "x", [p]: "y" });
      expect(r.status).toBe(400);
      const e = await errOf(r);
      expect(e.code).toBe("bad_request");
    });

  it("a nested __view is allowed", async () => {
    expect((await publish({ "index.html": "x", "d/__view": "y" })).status).toBe(
      201,
    );
  });

  it("content host serves 100%.txt (malformed escape → raw path)", async () => {
    const id = await create({ "index.html": "x", "100%.txt": "pct" });
    const r = await call(new URL("100%.txt", await contentUrl(id)).href, null);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("pct");
  });
});

describe("app host", () => {
  it("/_oa/* is a JSON 404, never the SPA or assets", async () => {
    for (const p of ["/_oa/manifest.json", "/_oa", "/_oa/x/y.js"]) {
      const r = await call(`${APP}${p}`, null);
      expect(r.status, p).toBe(404);
      expect(r.headers.get("content-type"), p).toMatch(/^application\/json/);
    }
  });

  it("versionFile Content-Disposition RFC 5987-encodes '()*", async () => {
    const id = await create({ "index.html": "x", "a'b(c)*.txt": "y" });
    const r = await call(
      `${APP}/api/v1/artifacts/${id}/versions/1/files/${encodeURIComponent("a'b(c)*.txt")}`,
      owner,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''a%27b%28c%29%2A.txt",
    );
  });
});
