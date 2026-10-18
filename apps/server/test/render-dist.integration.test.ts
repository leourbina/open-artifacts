// Serves the real @oa/render build (packages/render/dist, B11) through a fake
// ASSETS binding: a markdown __view's module graph must fully resolve.
// Skipped when the render package hasn't been built.
import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { signContentPrefix } from "../src/content/signing.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { contentCall } from "./assets-stub.js";
import { login } from "./helpers.js";

declare global {
  interface ImportMeta {
    /** Vite's static glob import (transformed at build time). */
    glob(
      pattern: string,
      opts: { query: string; import: string; eager: true },
    ): Record<string, unknown>;
  }
}

const dist = import.meta.glob("../../../packages/render/dist/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const files: Record<string, { body: string; type: string }> = {
  "/index.html": { body: "<html>SPA</html>", type: "text/html" },
};
for (const [p, body] of Object.entries(dist)) {
  const name = p.slice(p.lastIndexOf("/") + 1);
  const type = name.endsWith(".css")
    ? "text/css"
    : name.endsWith(".json")
      ? "application/json"
      : "text/javascript";
  files[`/_oa/${name}`] = { body, type };
}
const built = "/_oa/manifest.json" in files;

const assets = {
  fetch(input: Request | string) {
    const u = new URL(typeof input === "string" ? input : input.url);
    const f = files[u.pathname] ?? files["/index.html"];
    return Promise.resolve(
      new Response(f?.body ?? "", {
        headers: { "content-type": f?.type ?? "text/plain" },
      }),
    );
  },
};

describe.skipIf(!built)("real render dist via ASSETS (B11)", () => {
  let id = "";
  beforeAll(async () => {
    const l = await login(`rd-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const owner = await getUser(env, l.userId);
    if (!owner) throw new Error("no user");
    id = (
      await publish(
        env,
        owner,
        { title: "md", format: "markdown", content: "# hi" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
  });

  it("markdown __view module and every chunk URL resolve with 200", async () => {
    const prefix = await signContentPrefix(env, id, 1);
    const view = await contentCall(`${prefix}__view`, undefined, assets);
    expect(view.status).toBe(200);
    const html = await view.text();
    const entry = /<script type="module" src="(\/_oa\/[^"]+)"><\/script>/.exec(
      html,
    )?.[1];
    expect(entry).toMatch(/^\/_oa\/render\.[\w-]+\.js$/);

    // Crawl static and dynamic relative imports from the entry module.
    const seen = new Set<string>();
    const queue = [entry as string];
    // import x from "./a.js" | import("./a.js") | new URL("./a.mjs", …)
    const REL =
      /(?:\bfrom|\bimport|new URL)\s*\(?\s*["'`](\.\/[\w.@-]+\.(?:m?js|css))["'`]/g;
    while (queue.length) {
      const path = queue.shift() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      const r = await contentCall(path, undefined, assets);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      if (/\.m?js$/.test(path))
        expect(r.headers.get("content-type"), path).toBe(
          "text/javascript; charset=utf-8",
        );
      if (!path.endsWith(".js")) continue;
      for (const m of (await r.text()).matchAll(REL))
        queue.push(new URL(m[1] as string, `https://x${path}`).pathname);
    }
    // ~107 files: the entry, its chunks, lazy languages, mermaid, pdf.js.
    expect(seen.size).toBeGreaterThan(50);

    // Every file the manifest references is servable.
    const manifest = JSON.parse(files["/_oa/manifest.json"]?.body ?? "{}");
    for (const e of Object.values(manifest) as {
      file: string;
      css?: string[];
      assets?: string[];
    }[])
      for (const f of [e.file, ...(e.css ?? []), ...(e.assets ?? [])]) {
        const r = await contentCall(`/_oa/${f}`, undefined, assets);
        expect(r.status, f).toBe(200);
      }
  });
});
