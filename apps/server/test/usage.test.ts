import { env } from "cloudflare:workers";
import { newId, R, UsageSchema } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { api, fetchAndWait, login } from "./helpers.js";

const app = createApp();
let admin: { cookie: string };
let member: { cookie: string };
beforeAll(async () => {
  const t = newId().slice(0, 6).toLowerCase();
  admin = await login(`us-a-${t}@x.com`, "admin");
  member = await login(`us-m-${t}@x.com`, "member");
});
afterEach(() => vi.restoreAllMocks());

const gql = (over: object = {}) =>
  new Response(
    JSON.stringify({
      data: {
        viewer: {
          accounts: [
            {
              workers: [{ sum: { requests: 1200 } }],
              d1: [{ sum: { rowsRead: 3000, rowsWritten: 40 } }],
              dos: [{ sum: { requests: 77 } }],
            },
          ],
        },
      },
      errors: null,
      ...over,
    }),
    { headers: { "content-type": "application/json" } },
  );
const withToken = (token?: string) => ({
  ...(env as object),
  ANALYTICS_TOKEN: token,
});
const call = (cookie: string | null, e: unknown) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.usage}`, {
      headers: { ...(cookie ? { cookie } : {}), "x-oa-request": "1" },
    }),
    e,
  );

describe("usage", () => {
  it("owner/admin only; others 404", async () => {
    expect((await api(app, R.usage, member.cookie)).status).toBe(404);
    expect((await api(app, R.usage, null)).status).toBe(401);
  });

  it("no token -> unavailable", async () => {
    const r = await call(admin.cookie, withToken());
    const u = UsageSchema.parse(await r.json());
    expect(u).toMatchObject({ available: false, metrics: [] });
    expect(u.date).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it("maps GraphQL metrics and caches for 5 minutes", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    const e = { ...withToken("tok"), CF_ACCOUNT_ID: "acct-cache" };
    const u = UsageSchema.parse(await (await call(admin.cookie, e)).json());
    expect(u.available).toBe(true);
    expect(u.metrics).toEqual([
      { key: "requests", used: 1200, limit: 100000 },
      { key: "d1_reads", used: 3000, limit: 5000000 },
      { key: "d1_writes", used: 40, limit: 100000 },
      { key: "do_requests", used: 77, limit: 100000 },
    ]);
    const calls = spy.mock.calls.filter((c) =>
      String(c[0] instanceof Request ? c[0].url : c[0]).includes("graphql"),
    );
    expect(calls).toHaveLength(1);
    const init = calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
    const u2 = UsageSchema.parse(await (await call(admin.cookie, e)).json());
    expect(u2).toEqual(u);
    expect(
      spy.mock.calls.filter((c) => String(c[0]).includes("graphql")),
    ).toHaveLength(1);
  });

  it("GraphQL errors or bad shape -> available:false, not cached", async () => {
    const e = { ...withToken("tok"), CF_ACCOUNT_ID: "acct-err" };
    let n = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      n++;
      return n === 1
        ? gql({ errors: [{ message: "boom" }] })
        : new Response('{"data":{"nope":1}}', { status: 200 });
    });
    for (let i = 0; i < 2; i++) {
      const r = await call(admin.cookie, e);
      expect(r.status).toBe(200);
      expect(UsageSchema.parse(await r.json()).available).toBe(false);
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
