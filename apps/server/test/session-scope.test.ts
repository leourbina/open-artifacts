import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** env whose DB counts prepare() calls and whose ASSETS returns 200. */
function counted() {
  let n = 0;
  const DB = new Proxy(env.DB, {
    get(t, k) {
      if (k === "prepare" || k === "batch" || k === "exec") n++;
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const ASSETS = { fetch: async () => new Response("spa") } as never;
  return { e: { ...env, DB, ASSETS } as Env, count: () => n };
}

let cookie: string;
beforeAll(async () => {
  cookie = (await login(`scope-${newId().slice(0, 6).toLowerCase()}@x.com`))
    .cookie;
});

describe("session() scope", () => {
  for (const path of ["/library", "/", "/a/abc", "/assets/app.js"]) {
    it(`GET ${path} with a cookie makes no DB call`, async () => {
      const { e, count } = counted();
      const r = await app.fetch(
        new Request(`http://app.localhost${path}`, { headers: { cookie } }),
        e,
        ctx,
      );
      expect(r.status).toBe(200);
      expect(count()).toBe(0);
    });
  }

  it("GET /api/v1/me with a cookie does read the DB", async () => {
    const { e, count } = counted();
    const r = await app.fetch(
      new Request(`http://app.localhost${R.me}`, { headers: { cookie } }),
      e,
      ctx,
    );
    expect(r.status).toBe(200);
    expect(count()).toBeGreaterThan(0);
  });
});
