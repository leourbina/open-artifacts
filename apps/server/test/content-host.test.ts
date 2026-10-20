import { env } from "cloudflare:workers";
import { ContentUrlSchema, type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  CAPTURE_HEADER,
  publicPrefix,
  signCapture,
  signContentPrefix,
  signDownload,
  verifyContentPrefix,
} from "../src/content/signing.js";
import { appOrigin } from "../src/http/errors.js";
import { patch, publish, softDelete } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import {
  CHUNK_JS,
  contentCall as call,
  fakeAssets,
  LAZY_JS,
  ORPHAN_JS,
  RENDER_CSS,
  RENDER_JS,
  RUNTIME_JS,
  RUNTIME_TAG,
  WORKER_MJS,
} from "./assets-stub.js";
import { api, login } from "./helpers.js";

const app = createApp();
const CONTENT = "http://content.localhost";
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; member: Member };
let other: { cookie: string; member: Member };

async function mk(prefix: string) {
  const l = await login(`${prefix}-${tag}@x.com`, "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { cookie: l.cookie, member: m };
}

const pubSite = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "site",
        format: "html",
        entry: "index.html",
        files: {
          "index.html":
            '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>hi</body></html>',
          "style.css": "body{color:red}",
          "sub/a b.txt": "spaced",
        },
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

beforeAll(async () => {
  owner = await mk("ch-owner");
  other = await mk("ch-other");
});

describe("signing", () => {
  it("signs {exp}.{sig} and verifies only for the same id, v and window", async () => {
    const now = 1_800_000_000_000;
    const p = await signContentPrefix(env, "A".repeat(16), 1, now);
    const m = /^\/c\/(\d+)\.([A-Za-z0-9_-]+)\/A{16}\/v1\/$/.exec(p);
    expect(m).not.toBeNull();
    const token = p.split("/")[2] ?? "";
    expect(Number(m?.[1])).toBe(now / 1000 + 600);
    expect(await verifyContentPrefix(env, token, "A".repeat(16), 1, now)).toBe(
      true,
    );
    expect(await verifyContentPrefix(env, token, "A".repeat(16), 2, now)).toBe(
      false,
    );
    expect(await verifyContentPrefix(env, token, "B".repeat(16), 1, now)).toBe(
      false,
    );
    expect(
      await verifyContentPrefix(env, token, "A".repeat(16), 1, now + 601_000),
    ).toBe(false);
    for (const bad of ["", "x", `${m?.[1]}.`, `.${m?.[2]}`, `${token}=`])
      expect(await verifyContentPrefix(env, bad, "A".repeat(16), 1, now)).toBe(
        false,
      );
    expect(publicPrefix("abc", 3)).toBe("/p/abc/v3/");
  });

  it("rejects far-future exp even with a valid signature", async () => {
    const now = 1_800_000_000_000;
    const later = await signContentPrefix(env, "A".repeat(16), 1, now + 3600e3);
    const token = later.split("/")[2] ?? "";
    expect(await verifyContentPrefix(env, token, "A".repeat(16), 1, now)).toBe(
      false,
    );
  });
});

describe("content url route", () => {
  it("returns a signed __view URL for viewers, 404 for others and bad v", async () => {
    const id = await pubSite();
    const r = await api(app, R.contentUrl(id), owner.cookie);
    expect(r.status).toBe(200);
    const cu = ContentUrlSchema.parse(await r.json());
    expect(cu.url).toMatch(
      new RegExp(`^${CONTENT}/c/\\d+\\.[A-Za-z0-9_-]+/${id}/v1/__view$`),
    );
    expect(cu.expiresAt).not.toBeNull();
    const exp = Date.parse(cu.expiresAt ?? "");
    expect(exp - Date.now()).toBeGreaterThan(590_000);
    expect(exp - Date.now()).toBeLessThanOrEqual(600_000);
    expect((await api(app, R.contentUrl(id), other.cookie)).status).toBe(404);
    expect((await api(app, R.contentUrl(id), null)).status).toBe(404);
    expect((await api(app, R.contentUrl(id, 1), owner.cookie)).status).toBe(
      200,
    );
    expect((await api(app, R.contentUrl(id, 2), owner.cookie)).status).toBe(
      404,
    );
    expect(
      (await api(app, `${R.contentUrl(id)}?v=abc`, owner.cookie)).status,
    ).toBe(404);
  });

  it("public artifacts get an unsigned /p/ URL with expiresAt null", async () => {
    const id = await pubSite({ visibility: "public" });
    const r = await api(app, R.contentUrl(id), null);
    expect(r.status).toBe(200);
    expect(ContentUrlSchema.parse(await r.json())).toEqual({
      url: `${CONTENT}/p/${id}/v1/__view`,
      expiresAt: null,
    });
  });
});

describe("content host serving", () => {
  it("serves the entry and siblings under a valid signed prefix", async () => {
    const id = await pubSite();
    const prefix = await signContentPrefix(env, id, 1);
    const v = await call(`${prefix}__view`);
    expect(v.status).toBe(200);
    expect(v.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(v.headers.get("cache-control")).toBe("private, max-age=300");
    expect(await v.text()).toContain('href="style.css"');
    const css = await call(`${prefix}style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect(css.headers.get("content-type")).toContain("charset=utf-8");
    expect(css.headers.get("x-content-type-options")).toBe("nosniff");
    expect(css.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(css.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(await css.text()).toBe("body{color:red}");
    // Every text/html response gets the runtime, not only __view.
    const raw = await call(`${prefix}index.html`);
    expect(await raw.text()).toContain(RUNTIME_TAG);
    // Percent-encoded path is decoded once.
    const sp = await call(`${prefix}sub/a%20b.txt`);
    expect(sp.status).toBe(200);
    expect(await sp.text()).toBe("spaced");
  });

  it("404s for missing, invalid or traversal paths and directory listings", async () => {
    const id = await pubSite();
    const prefix = await signContentPrefix(env, id, 1);
    for (const p of [
      "missing.css",
      "",
      "sub/",
      "sub",
      "%2e%2e/style.css",
      "sub%2f..%2fstyle.css",
      "%ZZ",
      "style.css%00",
      "STYLE.CSS",
      "a%2520b.txt",
    ]) {
      const r = await call(`${prefix}${p}`);
      expect(r.status, p).toBe(404);
    }
    expect((await call(prefix.slice(0, -1))).status).toBe(404);
    // %2e%2e segments are resolved by the URL parser; they can't climb out of
    // the prefix's id/version (that would drop the /v{n}/ segment → 404).
    expect((await call(`${prefix}%2e%2e/%2e%2e/x/v1/style.css`)).status).toBe(
      404,
    );
  });

  it("expired token → 404; v1 token on v2 → 404; tampered → 404", async () => {
    const id = await pubSite();
    await publish(
      env,
      owner.member,
      { id, format: "html", content: "<p>v2</p>" } as never,
      null,
      undefined,
      "version",
    );
    const old = await signContentPrefix(env, id, 1, Date.now() - 601_000);
    expect((await call(`${old}__view`)).status).toBe(404);
    const v1 = await signContentPrefix(env, id, 1);
    expect((await call(`${v1}__view`)).status).toBe(200);
    expect((await call(`${v1.replace("/v1/", "/v2/")}__view`)).status).toBe(
      404,
    );
    const v2 = await signContentPrefix(env, id, 2);
    expect((await call(`${v2}__view`)).status).toBe(200);
    const tampered = v1.replace(/\/c\/(\d+)\./, (_, e) => `/c/${+e + 1}.`);
    expect((await call(`${tampered}__view`)).status).toBe(404);
    // Version that doesn't exist, even with a valid signature.
    const v9 = await signContentPrefix(env, id, 9);
    expect((await call(`${v9}__view`)).status).toBe(404);
  });

  it("deleted artifacts 404 even with a valid token", async () => {
    const id = await pubSite();
    const prefix = await signContentPrefix(env, id, 1);
    expect((await call(`${prefix}__view`)).status).toBe(200);
    await softDelete(env, owner.member, id);
    expect((await call(`${prefix}__view`)).status).toBe(404);
  });

  it("/p/ works only while public and not deleted", async () => {
    const id = await pubSite();
    const p = `${publicPrefix(id, 1)}__view`;
    expect((await call(p)).status).toBe(404);
    await patch(env, owner.member, id, { visibility: "public" });
    const ok = await call(p);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect((await call(`${publicPrefix(id, 1)}style.css`)).status).toBe(200);
    await patch(env, owner.member, id, { visibility: "team" });
    expect((await call(p)).status).toBe(404);
    await patch(env, owner.member, id, { visibility: "public" });
    expect((await call(p)).status).toBe(200);
    await softDelete(env, owner.member, id);
    expect((await call(p)).status).toBe(404);
  });

  it("supports single byte ranges", async () => {
    const id = await pubSite();
    const prefix = await signContentPrefix(env, id, 1);
    const r = await call(`${prefix}style.css`, {
      headers: { range: "bytes=0-3" },
    });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-3/15");
    expect(await r.text()).toBe("body");
    const s = await call(`${prefix}style.css`, {
      headers: { range: "bytes=-4" },
    });
    expect(s.status).toBe(206);
    expect(s.headers.get("content-range")).toBe("bytes 11-14/15");
    expect(await s.text()).toBe("red}");
    const o = await call(`${prefix}style.css`, {
      headers: { range: "bytes=10-" },
    });
    expect(o.status).toBe(206);
    expect(o.headers.get("content-range")).toBe("bytes 10-14/15");
    const bad = await call(`${prefix}style.css`, {
      headers: { range: "bytes=100-200" },
    });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */15");
    const multi = await call(`${prefix}style.css`, {
      headers: { range: "bytes=0-1,3-4" },
    });
    expect(multi.status).toBe(200);
    expect(await multi.text()).toBe("body{color:red}");
  });

  it("serves /_oa/* from ASSETS, immutable; nothing else from ASSETS", async () => {
    const a = fakeAssets();
    for (const f of [
      RENDER_JS,
      RENDER_CSS,
      RUNTIME_JS,
      CHUNK_JS,
      LAZY_JS,
      WORKER_MJS,
    ]) {
      const r = await call(`/_oa/${f}`, undefined, a.fetcher);
      expect(r.status, f).toBe(200);
      if (/\.m?js$/.test(f))
        expect(r.headers.get("content-type"), f).toBe(
          "text/javascript; charset=utf-8",
        );
      expect(r.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(r.headers.get("content-security-policy")).toContain("sandbox");
    }
    expect(
      (await call(`/_oa/${RENDER_JS}`, undefined, a.fetcher)).headers.get(
        "content-type",
      ),
    ).toMatch(/^text\/javascript/);
    expect(
      (await call(`/_oa/${RENDER_CSS}`, undefined, a.fetcher)).headers.get(
        "content-type",
      ),
    ).toMatch(/^text\/css/);
    // Missing files (ASSETS SPA-falls back to index.html) and manifests → 404.
    for (const p of [
      "/_oa/nope.js",
      `/_oa/${ORPHAN_JS}`,
      "/_oa/",
      "/_oa/manifest.json",
      "/_oa/runtime.manifest.json",
      "/_oa/../index.html",
      "/_oa/%2e%2e/index.html",
    ]) {
      const r = await call(p, undefined, a.fetcher);
      expect(r.status, p).toBe(404);
      expect(r.headers.get("cache-control"), p).toBe("no-store");
    }
    a.calls.length = 0;
    for (const p of ["/", "/index.html", "/assets/x.js", "/robots.txt"])
      await call(p, undefined, a.fetcher);
    expect(a.calls).toEqual([]);
  });

  it("html entry in a subdirectory: __view 302s to the encoded entry path", async () => {
    const id = await pubSite({
      entry: "my site/index.html",
      files: {
        "my site/index.html":
          '<html><head><link rel="stylesheet" href="style.css"></head></html>',
        "my site/style.css": "p{}",
      },
    });
    const prefix = await signContentPrefix(env, id, 1);
    const r = await call(`${prefix}__view`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("my%20site/index.html");
    expect(r.headers.get("cache-control")).toBe("private, max-age=300");
    const target = new URL(
      r.headers.get("location") ?? "",
      `http://content.localhost${prefix}__view`,
    );
    const page = await call(target.pathname);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(RUNTIME_TAG);
    const css = new URL("style.css", target);
    expect((await call(css.pathname)).status).toBe(200);
    // Public: same redirect, public cache headers.
    await patch(env, owner.member, id, { visibility: "public" });
    const p = await call(`${publicPrefix(id, 1)}__view`);
    expect(p.status).toBe(302);
    expect(p.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });

  it("the API and auth routes 404 on the content host", async () => {
    for (const p of ["/api/v1/me", "/auth/login", "/mcp", "/", "/c/", "/p/"])
      expect(
        (await call(p, { headers: { cookie: owner.cookie } })).status,
      ).toBe(404);
  });

  it("never sets cookies on any route", async () => {
    const id = await pubSite({ visibility: "public" });
    const prefix = await signContentPrefix(env, id, 1);
    for (const p of [
      `${prefix}__view`,
      `${prefix}style.css`,
      `${publicPrefix(id, 1)}__view`,
      `/_oa/${RUNTIME_JS}`,
      "/robots.txt",
      "/api/v1/me",
      "/auth/callback",
      "/nope",
    ]) {
      const r = await call(p, { headers: { cookie: owner.cookie } });
      expect(r.headers.get("set-cookie"), p).toBeNull();
    }
  });
});

describe("no top-level rendering (#292)", () => {
  const dest = (d: string) => ({
    headers: { "sec-fetch-dest": d, "sec-fetch-mode": "navigate" },
  });
  const APP_URL = appOrigin(env);
  const twoVersions = async () => {
    const id = await pubSite();
    await publish(
      env,
      owner.member,
      { id, format: "html", content: "<p>v2</p>" } as never,
      null,
      undefined,
      "version",
    );
    return id;
  };

  it("a framed load (and in-frame navigation) is served", async () => {
    const id = await pubSite();
    const prefix = await signContentPrefix(env, id, 1);
    for (const p of ["__view", "index.html", "sub/a%20b.txt"]) {
      const r = await call(`${prefix}${p}`, dest("iframe"));
      expect(r.status, p).toBe(200);
      expect(r.headers.get("vary")).toBe(`Sec-Fetch-Dest, ${CAPTURE_HEADER}`);
      expect(r.headers.get("content-security-policy")).toContain(
        `frame-ancestors ${APP_URL}`,
      );
    }
  });

  it("a top-level visit redirects: current → /full, an older version → /v/<n>", async () => {
    const id = await twoVersions();
    for (const p of ["__view", "index.html", "style.css", "nope.txt"]) {
      const latest = await call(
        `${await signContentPrefix(env, id, 2)}${p}`,
        dest("document"),
      );
      expect(latest.status, p).toBe(303);
      expect(latest.headers.get("location")).toBe(`${APP_URL}/a/${id}/full`);
      expect(latest.headers.get("cache-control")).toBe("no-store");
      expect(latest.headers.get("content-disposition")).toBeNull();
      expect(await latest.text()).toBe("");
      const old = await call(
        `${await signContentPrefix(env, id, 1)}${p}`,
        dest("document"),
      );
      expect(old.status, p).toBe(303);
      expect(old.headers.get("location")).toBe(`${APP_URL}/a/${id}/v/1`);
      expect(await old.text()).toBe("");
    }
    // Public /p/ too; a private artifact still 404s (no existence leak).
    expect(
      (await call(`${publicPrefix(id, 2)}__view`, dest("document"))).status,
    ).toBe(404);
    await patch(env, owner.member, id, { visibility: "public" });
    const pub = await call(`${publicPrefix(id, 2)}__view`, dest("document"));
    expect(pub.status).toBe(303);
    expect(pub.headers.get("location")).toBe(`${APP_URL}/a/${id}/full`);
  });

  it("no redirect before the token and the artifact check out", async () => {
    const id = await pubSite();
    const prefix = await signContentPrefix(env, id, 1);
    const tampered = prefix.replace(/\/c\/(\d+)\./, (_, e) => `/c/${+e + 1}.`);
    for (const p of [
      `${tampered}__view`,
      `${prefix.replace(id, "A".repeat(16))}__view`,
      `/c/x/${id}/v1/__view`,
      "/c/1.x/..%2F..%2Fevil.com/v1/__view",
      "/p/%2F%2Fevil.com/v1/__view",
    ]) {
      const r = await call(p, dest("document"));
      expect(r.status, p).toBe(404);
      expect(r.headers.get("location"), p).toBeNull();
    }
  });

  it("sub-resources and fetches load", async () => {
    const id = await pubSite();
    const prefix = await signContentPrefix(env, id, 1);
    for (const d of ["script", "style", "image", "font", "empty", "worker"]) {
      const r = await call(`${prefix}style.css`, {
        headers: { "sec-fetch-dest": d, "sec-fetch-mode": "no-cors" },
      });
      expect(r.status, d).toBe(200);
      expect(await r.text()).toBe("body{color:red}");
    }
  });

  it("no Sec-Fetch headers (agents, curl) → 200", async () => {
    const id = await pubSite();
    const prefix = await signContentPrefix(env, id, 1);
    const r = await call(`${prefix}index.html`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("hi");
  });

  it("a signed download (dl=1) is served top level as an attachment", async () => {
    const id = await pubSite();
    const { path } = await signDownload(env, id, 1, "index.html");
    expect(path).toMatch(/\?dl=1$/);
    const r = await call(path, dest("document"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe(
      `attachment; filename="index.html"; filename*=UTF-8''index.html`,
    );
    const body = await r.text();
    // The stored bytes: no runtime injected.
    expect(body).not.toContain(RUNTIME_TAG);
    expect(body).toContain('href="style.css"');
    const sp = await signDownload(env, id, 1, "sub/a b.txt");
    const s = await call(sp.path, dest("document"));
    expect(s.status).toBe(200);
    expect(s.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''a%20b.txt",
    );
    expect(await s.text()).toBe("spaced");
  });

  it("a tampered dl param is rejected", async () => {
    const id = await pubSite({ visibility: "public" });
    const frame = await signContentPrefix(env, id, 1);
    const { path: dl } = await signDownload(env, id, 1, "index.html");
    const tampered = [
      `${frame}index.html?dl=1`, // dl added to a frame token
      dl.replace("?dl=1", "?dl=0"),
      dl.replace("?dl=1", "?dl=true"),
      `${dl}&dl=1`,
      dl.replace("/v1/", "/v2/"),
      `${dl.replace("index.html?dl=1", "__view")}?dl=1`,
      `${publicPrefix(id, 1)}index.html?dl=1`, // unsigned
    ];
    for (const p of tampered) {
      for (const init of [dest("document"), undefined]) {
        const r = await call(p, init);
        expect(r.status, p).toBe(404);
        expect(r.headers.get("content-disposition"), p).toBeNull();
      }
    }
    // dl dropped from a dl token: the signature no longer matches either way.
    const dropped = dl.replace("?dl=1", "");
    expect((await call(dropped)).status).toBe(404);
    expect((await call(dropped, dest("document"))).status).toBe(404);
  });

  it("only a valid capture header renders top level (thumbnails)", async () => {
    const id = await twoVersions();
    const prefix = await signContentPrefix(env, id, 1);
    const top = (h?: string) =>
      call(`${prefix}__view`, {
        headers: {
          "sec-fetch-dest": "document",
          ...(h === undefined ? {} : { [CAPTURE_HEADER]: h }),
        },
      });
    // The URL alone redirects.
    expect((await top()).status).toBe(303);
    const good = await signCapture(env, id, 1);
    const r = await top(good);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("vary")).toContain(CAPTURE_HEADER);
    expect(await r.text()).toContain(RUNTIME_TAG);
    const [exp, sig] = good.split(".") as [string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [
      `${exp}.${flip(sig)}`, // wrong MAC
      `${+exp + 1}.${sig}`, // exp altered
      await signCapture(env, id, 2), // wrong v
      await signCapture(env, "A".repeat(16), 1), // wrong id
      await signCapture(env, id, 1, Date.now() - 120_000), // expired
      await signCapture(env, id, 1, Date.now() + 600_000), // far future
      // A URL token isn't a capture header.
      (prefix.split("/")[2] ?? "") as string,
      "",
    ]) {
      const b = await top(bad);
      expect(b.status, bad).toBe(303);
      expect(await b.text()).toBe("");
    }
  });
});
