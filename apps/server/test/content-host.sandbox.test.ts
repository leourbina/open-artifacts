// Review Focus #1 (server side): the content host is an opaque-origin sandbox.
import { env } from "cloudflare:workers";
import { type Member, newId } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { publicPrefix, signContentPrefix } from "../src/content/signing.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import {
  contentCall as call,
  RENDER_JS,
  RUNTIME_TAG as RUNTIME,
  RUNTIME_JS,
} from "./assets-stub.js";
import { login } from "./helpers.js";

const CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors http://app.localhost";
let owner: Member;

async function pub(input: Record<string, unknown>): Promise<string> {
  return (
    await publish(
      env,
      owner,
      { title: "t", ...input } as never,
      null,
      undefined,
      "create",
    )
  ).id;
}
async function view(input: Record<string, unknown>): Promise<string> {
  const id = await pub(input);
  const r = await call(`${await signContentPrefix(env, id, 1)}__view`);
  expect(r.status).toBe(200);
  return r.text();
}

beforeAll(async () => {
  const l = await login(`sb-${newId().slice(0, 6).toLowerCase()}@x.com`);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  owner = m;
});

describe("content host sandbox (Review Focus #1)", () => {
  it("every response has the exact CSP sandbox header, never allow-same-origin", async () => {
    const id = await pub({ format: "html", content: "<p>x</p>" });
    const pubId = await pub({
      format: "html",
      content: "<p>x</p>",
      visibility: "public",
    });
    const prefix = await signContentPrefix(env, id, 1);
    const expired = await signContentPrefix(env, id, 1, Date.now() - 700_000);
    const paths = [
      `${prefix}__view`,
      `${prefix}index.html`,
      `${prefix}missing`,
      `${expired}__view`,
      `${publicPrefix(pubId, 1)}__view`,
      `${publicPrefix(id, 1)}__view`,
      `/_oa/${RUNTIME_JS}`,
      `/_oa/${RENDER_JS}`,
      "/_oa/nope.js",
      "/robots.txt",
      "/api/v1/me",
      "/",
      "/c/garbage/x/v1/__view",
    ];
    for (const p of paths) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const r = await call(p, { method });
        const csp = r.headers.get("content-security-policy");
        expect(csp, `${method} ${p}`).toBe(CSP);
        expect(csp).not.toContain("allow-same-origin");
        expect(csp).not.toContain("allow-top-navigation");
        expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        expect(r.headers.get("cross-origin-resource-policy")).toBe(
          "cross-origin",
        );
        expect(r.headers.get("set-cookie")).toBeNull();
        // Sandboxed iframes have origin "null": wildcard CORS, no credentials.
        expect(r.headers.get("access-control-allow-origin")).toBe("*");
        expect(r.headers.get("access-control-allow-credentials")).toBeNull();
        expect(r.headers.get("vary") ?? "").not.toMatch(/origin/i);
      }
    }
    const err = await call("/nope");
    expect(err.status).toBe(404);
    expect(err.headers.get("cache-control")).toBe("no-store");
  });

  it("injects the runtime into an HTML entry without <head> (and without <html>)", async () => {
    const a = await view({
      format: "html",
      content: "<html><body><p>hi</p></body></html>",
    });
    expect(a).toBe(
      `<html><head>${RUNTIME}</head><body><p>hi</p></body></html>`,
    );
    const b = await view({ format: "html", content: "<p>bare</p>" });
    expect(b).toBe(`<head>${RUNTIME}</head><p>bare</p>`);
    const c = await view({ format: "html", content: "just text" });
    expect(c).toBe(`<head>${RUNTIME}</head>just text`);
    const d = await view({ format: "html", content: "<!doctype html>" });
    expect(d).toBe(`<!doctype html><head>${RUNTIME}</head>`);
    const e = await view({
      format: "html",
      content: "<!doctype html><title>x</title><p>y</p>",
    });
    expect(e).toBe(
      `<!doctype html><head>${RUNTIME}</head><title>x</title><p>y</p>`,
    );
  });

  it("keeps the runtime first when the head already has a <script>", async () => {
    const html =
      '<!DOCTYPE html><html lang="en"><head><script>window.x=1</script><title>T</title></head><body><head></head></body></html>';
    const out = await view({ format: "html", content: html });
    expect(out).toBe(
      `<!DOCTYPE html><html lang="en"><head>${RUNTIME}<script>window.x=1</script><title>T</title></head><body><head></head></body></html>`,
    );
    expect(out.split(RUNTIME).length).toBe(2);
  });

  it("markdown __view is a static template: escaped meta, no inline user content", async () => {
    const secret = "SECRET-BODY-<script>alert(1)</script>";
    const out = await view({
      format: "markdown",
      entry: 'we"ird<&>.md',
      files: { 'we"ird<&>.md': `# ${secret}` },
    });
    expect(out).not.toContain("SECRET-BODY");
    expect(out).not.toContain("<script>alert");
    expect(out).toContain(
      '<meta name="oa-entry" content="we&quot;ird&lt;&amp;&gt;.md">',
    );
    expect(out).toContain('<meta name="oa-format" content="markdown">');
    expect(out).toContain('<meta name="oa-language" content="">');
    expect(out).toContain(
      `<script type="module" src="/_oa/${RENDER_JS}"></script>`,
    );
    // Runtime first in every text/html response, the template included.
    expect(out.indexOf(RUNTIME)).toBeGreaterThan(0);
    expect(out.indexOf(RUNTIME)).toBeLessThan(out.indexOf(RENDER_JS));
  });

  it("injects into secondary HTML pages too, and not into non-HTML files", async () => {
    const id = await pub({
      format: "html",
      entry: "index.html",
      files: {
        "index.html": "<p>i</p>",
        "about.html": "<html><head><title>a</title></head></html>",
        "data.txt": "<head>not html</head>",
      },
    });
    const prefix = await signContentPrefix(env, id, 1);
    expect(await (await call(`${prefix}about.html`)).text()).toBe(
      `<html><head>${RUNTIME}<title>a</title></head></html>`,
    );
    expect(await (await call(`${prefix}index.html`)).text()).toBe(
      `<head>${RUNTIME}</head><p>i</p>`,
    );
    expect(await (await call(`${prefix}data.txt`)).text()).toBe(
      "<head>not html</head>",
    );
  });

  it("injects nothing until the runtime bundle exists (B13)", async () => {
    const { fakeAssets, DEFAULT_FILES } = await import("./assets-stub.js");
    const { "/_oa/runtime.manifest.json": _, ...rest } = DEFAULT_FILES;
    const id = await pub({ format: "html", content: "<p>x</p>" });
    const r = await call(
      `${await signContentPrefix(env, id, 1)}__view`,
      undefined,
      fakeAssets(rest).fetcher,
    );
    expect(await r.text()).toBe("<p>x</p>");
  });

  it("markdown __view without a render manifest → 503 page with CSP", async () => {
    const { fakeAssets, DEFAULT_FILES } = await import("./assets-stub.js");
    const { "/_oa/manifest.json": _, ...rest } = DEFAULT_FILES;
    const id = await pub({ format: "markdown", content: "# x" });
    const r = await call(
      `${await signContentPrefix(env, id, 1)}__view`,
      undefined,
      fakeAssets(rest).fetcher,
    );
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain("Renderer not deployed yet");
  });

  it("code __view carries the escaped language", async () => {
    const out = await view({
      format: "code",
      entry: "main.py",
      language: 'py"><x',
      files: { "main.py": "print('hidden-user-code')" },
    });
    expect(out).not.toContain("hidden-user-code");
    expect(out).toContain('<meta name="oa-format" content="code">');
    expect(out).toContain(
      '<meta name="oa-language" content="py&quot;&gt;&lt;x">',
    );
  });
});
