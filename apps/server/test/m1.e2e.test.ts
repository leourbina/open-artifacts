import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeAssets } from "./assets-stub.js";
import { fetchAndWait, runIndex } from "./helpers.js";

const assets = fakeAssets().fetcher;
const E = (over: Record<string, unknown> = {}) =>
  ({ ...(env as object), ASSETS: assets, ...over }) as never;

async function call(
  url: string,
  init: RequestInit & { cookie?: string } = {},
  e = E(),
) {
  const h = new Headers(init.headers);
  if (init.cookie) h.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") h.set("x-oa-request", "1");
  if (typeof init.body === "string") h.set("content-type", "application/json");
  // Awaits waitUntil work (search indexing) so later searches never race it.
  return fetchAndWait(
    worker as never,
    new Request(url, { ...init, headers: h }),
    e,
  );
}
const APP = "http://app.localhost";
const CT = "http://content.localhost";

async function devLogin(email: string) {
  const r = await call(`${APP}/auth/dev-login?email=${email}&role=member`);
  expect(r.status).toBe(302);
  const c = r.headers.get("set-cookie") ?? "";
  return c.split(";")[0] ?? "";
}

function checkHeaders(r: Response, host: "app" | "content") {
  expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  if (host === "content") {
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("content-security-policy")).toMatch(/^sandbox /);
  } else {
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  }
}

describe("M1 journey", () => {
  it("publish → view → restore → delete → undelete", async () => {
    const tag = newId().slice(0, 6).toLowerCase();
    const owner = await devLogin(`j-${tag}@x.com`);
    const other = await devLogin(`o-${tag}@x.com`);
    const pub = await call(`${APP}/api/v1/artifacts`, {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({
        title: `journey ${tag}`,
        entry: "index.html",
        files: {
          "index.html":
            '<!doctype html><html><head><link rel="stylesheet" href="css/s.css"></head><body>zebrafish</body></html>',
          "css/s.css": "body{color:red}",
        },
      }),
    });
    checkHeaders(pub, "app");
    expect(pub.status).toBe(201);
    const { id } = (await pub.json()) as { id: string };
    await runIndex(id);
    for (const p of [
      `/api/v1/artifacts/${id}`,
      `/api/v1/artifacts?scope=mine`,
      `/api/v1/search?q=zebrafish`,
    ]) {
      const r = await call(APP + p, { cookie: owner });
      checkHeaders(r, "app");
      expect(r.status, p).toBe(200);
      expect(JSON.stringify(await r.json()), p).toContain(id);
    }
    const cu = await call(`${APP}/api/v1/artifacts/${id}/content-url`, {
      cookie: owner,
    });
    const { url } = (await cu.json()) as { url: string };
    const view = await call(url);
    checkHeaders(view, "content");
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("zebrafish");
    const css = await call(new URL("css/s.css", url).href);
    checkHeaders(css, "content");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);

    // app host never serves bytes inline
    const vf = await call(
      `${APP}/api/v1/artifacts/${id}/versions/1/files/index.html`,
      { cookie: owner },
    );
    expect(vf.headers.get("content-disposition")).toMatch(/^attachment/);

    // v2 then restore v1 → v3
    const v2 = await call(`${APP}/api/v1/artifacts/${id}/versions`, {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({ files: { "index.html": "<p>v2</p>" } }),
    });
    expect(v2.status).toBe(201);
    const rs = await call(`${APP}/api/v1/artifacts/${id}/versions/1/restore`, {
      method: "POST",
      cookie: owner,
    });
    expect(((await rs.json()) as { version: number }).version).toBe(3);
    const old = await call(`${APP}/api/v1/artifacts/${id}/content-url?v=1`, {
      cookie: owner,
    });
    const oldUrl = ((await old.json()) as { url: string }).url;
    expect((await call(oldUrl)).status).toBe(200);
    // other user: 404 for everything
    expect(
      (
        await call(`${APP}/api/v1/artifacts/${id}/content-url`, {
          cookie: other,
        })
      ).status,
    ).toBe(404);

    // soft delete → all 404
    const del = await call(`${APP}/api/v1/artifacts/${id}`, {
      method: "DELETE",
      cookie: owner,
    });
    expect(del.status).toBe(204);
    for (const p of [
      `/api/v1/artifacts/${id}`,
      `/api/v1/artifacts/${id}/content-url`,
      `/api/v1/artifacts/${id}/versions`,
      `/api/v1/artifacts/${id}/versions/1/files/index.html`,
    ])
      expect((await call(APP + p, { cookie: owner })).status, p).toBe(404);
    expect((await call(url)).status).toBe(404);
    expect((await call(new URL("css/s.css", url).href)).status).toBe(404);
    const s = await call(`${APP}/api/v1/search?q=zebrafish`, { cookie: owner });
    expect(JSON.stringify(await s.json())).not.toContain(id);
    const un = await call(`${APP}/api/v1/artifacts/${id}/undelete`, {
      method: "POST",
      cookie: owner,
    });
    expect(un.status).toBe(200);
    expect((await call(url)).status).toBe(200);
  });

  it("format follows the version: old md version stays md after an html publish", async () => {
    const tag = newId().slice(0, 6).toLowerCase();
    const owner = await devLogin(`f-${tag}@x.com`);
    const pub = await call(`${APP}/api/v1/artifacts`, {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({ title: "fmt", files: { "README.md": "# hi" } }),
    });
    const { id } = (await pub.json()) as { id: string };
    await call(`${APP}/api/v1/artifacts/${id}/versions`, {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({ files: { "index.html": "<p>html</p>" } }),
    });
    const cu = await call(`${APP}/api/v1/artifacts/${id}/content-url?v=1`, {
      cookie: owner,
    });
    const v1 = await call(((await cu.json()) as { url: string }).url);
    const body = await v1.text();
    // Expect the markdown renderer page, not raw README.md served as text/html.
    expect(body).toContain('name="oa-format" content="markdown"');
    // restore v1 → artifact must be markdown again
    await call(`${APP}/api/v1/artifacts/${id}/versions/1/restore`, {
      method: "POST",
      cookie: owner,
    });
    const s = await call(`${APP}/api/v1/artifacts/${id}`, { cookie: owner });
    expect(((await s.json()) as { format: string }).format).toBe("markdown");
  });

  it("D1 quota → 503 on every route group, both hosts", async () => {
    const tag = newId().slice(0, 6).toLowerCase();
    const owner = await devLogin(`q-${tag}@x.com`);
    const pub = await call(`${APP}/api/v1/artifacts`, {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({
        title: "q",
        visibility: "public",
        files: { "index.html": "x" },
      }),
    });
    const { id } = (await pub.json()) as { id: string };
    const boom = () => {
      throw new Error(
        "D1_ERROR: Your account has exceeded D1's free tier daily row read limit",
      );
    };
    const DB = new Proxy((env as { DB: D1Database }).DB, {
      get(t, k) {
        if (k === "prepare")
          return () => ({
            bind: () => ({ first: boom, all: boom, run: boom, raw: boom }),
            first: boom,
            all: boom,
            run: boom,
            raw: boom,
          });
        if (k === "batch") return boom;
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const eq = E({ DB });
    const routes: [string, RequestInit & { cookie?: string }][] = [
      [`${APP}/api/v1/me`, { cookie: owner }],
      [`${APP}/api/v1/artifacts`, { cookie: owner }],
      [`${APP}/api/v1/artifacts/${id}`, {}],
      [`${APP}/api/v1/search?q=x`, { cookie: owner }],
      [`${APP}/api/v1/members`, { cookie: owner }],
      [`${APP}/api/v1/settings`, { cookie: owner }],
      [`${APP}/api/v1/artifacts/${id}/shares`, { cookie: owner }],
      [
        `${APP}/api/v1/uploads`,
        {
          method: "POST",
          cookie: owner,
          body: JSON.stringify({ path: "a.txt", size: 1 }),
        },
      ],
      [`${APP}/auth/dev-login?email=z-${tag}@x.com`, {}],
      [`${CT}/p/${id}/v1/__view`, {}],
      [`${CT}/p/${id}/v1/index.html`, {}],
    ];
    const bad: string[] = [];
    for (const [u, init] of routes) {
      const r = await call(u, init, eq);
      if (r.status !== 503) bad.push(`${u} ${r.status}`);
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    expect(bad).toEqual([]);
  });

  it("header invariants on odd statuses, both hosts", async () => {
    const cases: [string, RequestInit][] = [
      [`${APP}/robots.txt`, {}],
      [`${CT}/robots.txt`, {}],
      [`${APP}/robots.txt`, { method: "POST" }],
      [`${CT}/robots.txt`, { method: "POST" }],
      [`${CT}/c/bad/x/v1/a`, {}],
      [`${CT}/p/${"A".repeat(16)}/v1/__view`, { method: "OPTIONS" }],
      [
        `${APP}/api/v1/artifacts`,
        {
          method: "OPTIONS",
          headers: { origin: "null", "access-control-request-method": "POST" },
        },
      ],
      [`${APP}/api/v1/nope`, {}],
      [`${APP}/a/${"A".repeat(16)}`, {}],
      [`${CT}/`, {}],
      [`${CT}/auth/dev-login?email=a@b.com`, {}],
    ];
    const out: string[] = [];
    for (const [u, i] of cases) {
      const r = await call(u, i);
      out.push(
        `${i.method ?? "GET"} ${u} ${r.status} acao=${r.headers.get("access-control-allow-origin")} cookie=${r.headers.get("set-cookie")} xrt=${r.headers.get("x-robots-tag")}`,
      );
      expect(r.headers.get("x-robots-tag"), u).toBe("noindex, nofollow");
      if (u.startsWith(CT)) expect(r.headers.get("set-cookie")).toBeNull();
      else expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
    console.log(out.join("\n"));
  });
});

describe("M1 cross-module", () => {
  it("concurrent publish + restore → consecutive distinct versions", async () => {
    const tag = newId().slice(0, 6).toLowerCase();
    const owner = await devLogin(`c-${tag}@x.com`);
    const pub = await call(`${APP}/api/v1/artifacts`, {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({ title: "c", files: { "index.html": "v1" } }),
    });
    const { id } = (await pub.json()) as { id: string };
    const rs = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) =>
        call(`${APP}/api/v1/artifacts/${id}/versions`, {
          method: "POST",
          cookie: owner,
          body: JSON.stringify({ files: { "index.html": `p${i}` } }),
        }),
      ),
      ...Array.from({ length: 4 }, () =>
        call(`${APP}/api/v1/artifacts/${id}/versions/1/restore`, {
          method: "POST",
          cookie: owner,
        }),
      ),
    ]);
    const vs = await Promise.all(
      rs.map(async (r) => ((await r.json()) as { version: number }).version),
    );
    expect(vs.sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("revoked share / visibility change stop new URLs and public paths", async () => {
    const tag = newId().slice(0, 6).toLowerCase();
    const owner = await devLogin(`s-${tag}@x.com`);
    const guest = await devLogin(`g-${tag}@x.com`);
    const pub = await call(`${APP}/api/v1/artifacts`, {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({
        title: "s",
        visibility: "public",
        files: { "index.html": "x" },
      }),
    });
    const { id } = (await pub.json()) as { id: string };
    const share = await call(`${APP}/api/v1/artifacts/${id}/shares`, {
      method: "PUT",
      cookie: owner,
      body: JSON.stringify({ email: `g-${tag}@x.com`, role: "viewer" }),
    });
    expect(share.status).toBe(200);
    const pubUrl = (
      (await (
        await call(`${APP}/api/v1/artifacts/${id}/content-url`, {
          cookie: guest,
        })
      ).json()) as { url: string }
    ).url;
    expect(pubUrl).toContain("/p/");
    expect((await call(pubUrl)).status).toBe(200);
    await call(`${APP}/api/v1/artifacts/${id}`, {
      method: "PATCH",
      cookie: owner,
      body: JSON.stringify({ visibility: "private" }),
    });
    expect((await call(pubUrl)).status).toBe(404);
    const signed = (
      (await (
        await call(`${APP}/api/v1/artifacts/${id}/content-url`, {
          cookie: guest,
        })
      ).json()) as { url: string }
    ).url;
    expect((await call(signed)).status).toBe(200);
    const del = await call(
      `${APP}/api/v1/artifacts/${id}/shares/${encodeURIComponent(`g-${tag}@x.com`)}`,
      { method: "DELETE", cookie: owner },
    );
    expect(del.status).toBe(204);
    expect(
      (
        await call(`${APP}/api/v1/artifacts/${id}/content-url`, {
          cookie: guest,
        })
      ).status,
    ).toBe(404);
    expect((await call(signed)).status).toBe(200); // already-issued: valid until expiry (by design)
  });

  it("hostile paths: upload+publish+serve", async () => {
    const tag = newId().slice(0, 6).toLowerCase();
    const owner = await devLogin(`h-${tag}@x.com`);
    const out: string[] = [];
    for (const p of [
      "../x",
      "/etc/passwd",
      "a\\b",
      "./a/../../b",
      "a//b",
      "a\u0000b",
      "x".repeat(513),
      "__view",
      "%2e%2e/x",
      "a/./b",
    ]) {
      const r = await call(`${APP}/api/v1/uploads`, {
        method: "POST",
        cookie: owner,
        body: JSON.stringify({ path: p, size: 1 }),
      });
      const r2 = await call(`${APP}/api/v1/artifacts`, {
        method: "POST",
        cookie: owner,
        body: JSON.stringify({
          title: "h",
          entry: "index.html",
          files: { "index.html": "x", [p]: "y" },
        }),
      });
      out.push(
        `${JSON.stringify(p).slice(0, 20)} upload=${r.status} publish=${r2.status}`,
      );
    }
    console.log(out.join("\n"));
  });
});
