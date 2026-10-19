import { env } from "cloudflare:workers";
import { type Member, newId, viewerPath } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { fakeAssets } from "./assets-stub.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const INDEX = `<!doctype html><html><head><title>Old</title></head><body><div id="root"></div></body></html>`;
const assets = fakeAssets({
  "/index.html": { body: INDEX, type: "text/html" },
}).fetcher;
const get = (path: string, extra: object = {}) =>
  fetchAndWait(app, new Request(`http://app.localhost${path}`), {
    ...(env as object),
    ASSETS: assets,
    ...extra,
  });
const setName = (name: string) =>
  env.DB.prepare(
    "insert or replace into settings (key, value) values ('name', ?)",
  )
    .bind(name)
    .run();
const metas = (t: string) => t.match(/<meta name="oa-instance"[^>]*>/g) ?? [];

let owner: Member;
beforeAll(async () => {
  const l = await login(`sh-${newId().slice(0, 6).toLowerCase()}@x.com`);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  owner = m;
});
const mk = async (visibility: string, title: string, description: string) =>
  (
    await publish(
      env,
      owner,
      {
        title,
        description,
        visibility,
        format: "markdown",
        content: "x",
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

describe("OG shell", () => {
  it("public artifact gets title and og tags", async () => {
    const id = await mk("public", 'Roadmap <b>"Q3"</b>', "Plan & more");
    const r = await get(viewerPath(id));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const t = await r.text();
    expect(t).toContain("&lt;b&gt;");
    expect(t).not.toContain("<b>");
    expect(t).toContain("&quot;Q3&quot;");
    expect(t).toContain('property="og:title"');
    expect(t).toContain('property="og:type" content="website"');
    expect(t).toContain(`content="http://app.localhost${viewerPath(id)}"`);
    expect(t).toContain("Plan &amp; more");
    expect(t).toContain("· Open Artifacts</title>");
    const v = await (await get(viewerPath(id, 1))).text();
    expect(v).toContain('property="og:title"');
  });

  it("private, missing and deleted ids are byte-identical and leak nothing", async () => {
    const priv = await mk("private", "SecretTitleXyz", "SecretDescXyz");
    const gone = await mk("public", "GoneTitleXyz", "GoneDescXyz");
    await env.DB.prepare("update artifacts set deleted_at = 1 where id = ?")
      .bind(gone)
      .run();
    const a = await (await get(viewerPath(priv))).text();
    const b = await (await get(viewerPath(newId()))).text();
    const c = await (await get(viewerPath(gone))).text();
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toContain("<title>Open Artifacts</title>");
    expect(a).not.toContain("og:");
    expect(a).not.toContain("SecretTitleXyz");
    expect(a).not.toContain("SecretDescXyz");
  });

  it("other /a/ paths fall through to the SPA", async () => {
    const id = await mk("public", "T", "D");
    const t = await (await get(`/a/${id}/diff/1/2`)).text();
    expect(t.replace(/<meta name="oa-instance"[^>]*>/, "")).toBe(INDEX);
  });
});

describe("instance meta", () => {
  it("signed-out shell routes carry exactly one instance meta", async () => {
    await setName("Acme Docs");
    const id = await mk("public", "T", "D");
    for (const p of ["/", "/library", viewerPath(id), viewerPath(newId())]) {
      const r = await get(p);
      expect(r.status).toBe(200);
      const t = await r.text();
      expect(metas(t)).toEqual([
        '<meta name="oa-instance" content="Acme Docs">',
      ]);
      expect(t).toMatch(/<head>.*oa-instance.*<\/head>/);
    }
  });

  it("escapes the name", async () => {
    await setName('Evil"><script>alert(1)</script> & co');
    for (const p of ["/", viewerPath(newId())]) {
      const t = await (await get(p)).text();
      expect(t).not.toContain("<script>");
      expect(metas(t)).toEqual([
        '<meta name="oa-instance" content="Evil&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; co">',
      ]);
    }
  });

  it("a failed settings read serves the shell without the meta", async () => {
    // Only the settings read fails (the /a/:id OG read still works).
    const DB = new Proxy(env.DB, {
      get(t, k) {
        if (k === "prepare")
          return (sql: string) => {
            if (sql.includes("from settings")) throw new Error("d1 down");
            return t.prepare(sql);
          };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    for (const p of ["/", "/library", viewerPath(newId())]) {
      const r = await get(p, { DB });
      expect(r.status).toBe(200);
      const t = await r.text();
      expect(t).toContain('<div id="root">');
      expect(metas(t)).toEqual([]);
    }
  });

  it("static assets are untouched", async () => {
    const files = fakeAssets({
      "/index.html": { body: INDEX, type: "text/html" },
      "/assets/app.js": { body: "/*js*/", type: "text/javascript" },
      "/favicon.svg": { body: "<svg/>", type: "image/svg+xml" },
    }).fetcher;
    for (const p of ["/assets/app.js", "/assets/missing.js", "/favicon.svg"]) {
      const r = await get(p, { ASSETS: files });
      expect(r.headers.get("etag")).toBe('"e1"');
      expect(metas(await r.text())).toEqual([]);
    }
  });
});
