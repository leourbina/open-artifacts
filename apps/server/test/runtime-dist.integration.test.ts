// Serves the real @oa/runtime build (packages/runtime/dist, B13) through a fake
// ASSETS binding: HTML artifacts get its <script>, and its lazy chunks resolve.
// Skipped when the runtime package hasn't been built.
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
    glob(
      pattern: string,
      opts: { query: string; import: string; eager: true },
    ): Record<string, unknown>;
  }
}

const dist = import.meta.glob("../../../packages/runtime/dist/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const files: Record<string, { body: string; type: string }> = {
  "/index.html": { body: "<html>SPA</html>", type: "text/html" },
};
for (const [p, body] of Object.entries(dist)) {
  const name = p.slice(p.lastIndexOf("/") + 1);
  files[`/_oa/${name}`] = {
    body,
    type: name.endsWith(".json") ? "application/json" : "text/javascript",
  };
}
const built = "/_oa/runtime.manifest.json" in files;
const assets = {
  fetch(input: Request | string) {
    const u = new URL(typeof input === "string" ? input : input.url);
    const f = files[u.pathname];
    return Promise.resolve(
      f
        ? new Response(f.body, { headers: { "content-type": f.type } })
        : new Response("nf", { status: 404 }),
    );
  },
};

describe.skipIf(!built)("real runtime dist via ASSETS (B13)", () => {
  let id = "";
  beforeAll(async () => {
    const l = await login(`rtd-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const owner = await getUser(env, l.userId);
    if (!owner) throw new Error("no user");
    id = (
      await publish(
        env,
        owner,
        { title: "h", format: "html", content: "<p>x</p>" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
  });

  it("injects runtime.<hash>.js; it and its lazy chunks are servable", async () => {
    const prefix = await signContentPrefix(env, id, 1);
    const page = await contentCall(`${prefix}index.html`, undefined, assets);
    expect(page.status).toBe(200);
    const src = /<script src="(\/_oa\/runtime\.[\w-]+\.js)"><\/script>/.exec(
      await page.text(),
    )?.[1];
    expect(src).toBeDefined();
    const rt = await contentCall(src as string, undefined, assets);
    expect(rt.status).toBe(200);
    const code = await rt.text();
    const chunks = [
      ...code.matchAll(/["'`]\.\/((?:schemas|snapshot)\.[\w-]+\.js)["'`]/g),
    ].map((m) => m[1]);
    expect(new Set(chunks).size).toBe(2);
    for (const f of chunks) {
      const r = await contentCall(`/_oa/${f}`, undefined, assets);
      expect(r.status, f).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(r.headers.get("content-type")).toBe(
        "text/javascript; charset=utf-8",
      );
    }
  });
});
