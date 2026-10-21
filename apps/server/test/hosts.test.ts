import { describe, expect, it } from "vitest";
import { callWorker, E } from "./mcp-helpers.js";

// P1 Task 6b: the Worker answers its own hosts only. Under a Workers for
// Platforms wildcard route, another install's hostname must not reach this
// one. Test env: APP_HOST=app.localhost, CONTENT_HOST=content.localhost,
// ENVIRONMENT=dev.

const get = (
  url: string,
  over: Record<string, unknown> = {},
  init: RequestInit = {},
) => callWorker(new Request(url, init), E(over));

describe("the Worker answers only its own hosts", () => {
  it("serves APP_HOST", async () => {
    expect((await get("http://app.localhost/healthz")).status).toBe(200);
  });

  it("normalizes case, a trailing dot and an explicit port", async () => {
    for (const host of [
      "APP.LOCALHOST",
      "app.localhost.",
      "app.localhost:8787",
    ])
      expect((await get(`http://${host}/healthz`)).status).toBe(200);
  });

  it("keeps serving the content host", async () => {
    // /healthz is not a content route: the content app's own 404, not the
    // app's 200, proves the request was routed there.
    expect((await get("http://content.localhost/healthz")).status).toBe(404);
  });

  it("answers a foreign host with a plain 404 before auth", async () => {
    const r = await get(
      "https://other-install.example/healthz",
      {},
      {
        headers: {
          authorization: "Bearer oa_pat_0123456789abcdef",
          cookie: "oa_session=whatever",
          "x-forwarded-host": "app.localhost",
        },
      },
    );
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found");
    // Nothing from the app's error shape or its security headers.
    expect(r.headers.get("content-security-policy")).toBeNull();
  });

  it("ignores X-Forwarded-Host in the other direction too", async () => {
    const r = await get(
      "http://app.localhost/healthz",
      {},
      {
        headers: { "x-forwarded-host": "other-install.example" },
      },
    );
    expect(r.status).toBe(200);
  });

  it("dev also answers localhost and 127.0.0.1", async () => {
    for (const host of ["localhost", "127.0.0.1", "localhost:8788"])
      expect((await get(`http://${host}/healthz`)).status).toBe(200);
  });

  it("production does not answer localhost", async () => {
    for (const host of ["localhost", "127.0.0.1"])
      expect(
        (await get(`http://${host}/healthz`, { ENVIRONMENT: "production" }))
          .status,
      ).toBe(404);
  });

  it("self-host unchanged: APP_HOST unset keeps the any-host behavior", async () => {
    for (const host of ["app.localhost", "anything.example", "localhost"])
      expect(
        (
          await get(`http://${host}/healthz`, {
            APP_HOST: undefined,
            ENVIRONMENT: "production",
          })
        ).status,
      ).toBe(200);
  });
});
