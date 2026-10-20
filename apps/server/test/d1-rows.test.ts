// #248: D1 bills rows written (every index entry, and 1 per FTS statement).
// Pins the per-publish costs measured there, after the cuts.
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { indexVersionOrThrow } from "../src/services/search.js";
import { api, login } from "./helpers.js";

/** env.DB whose run/batch results add their meta.rows_written to `rows.n`. */
const rows = { n: 0 };
const add = (r: D1Result) => {
  rows.n += r.meta.rows_written;
  return r;
};
const DB = new Proxy(env.DB, {
  get(t, p) {
    if (p === "batch")
      return async (ss: D1PreparedStatement[]) => (await t.batch(ss)).map(add);
    const v = Reflect.get(t, p);
    return typeof v === "function" ? v.bind(t) : v;
  },
});
const counted = { ...(env as object), DB } as typeof env;
const app = createApp();
const A = {
  fetch: (r: Request, _e: unknown, c: never) => app.fetch(r, counted, c),
};

let cookie: string;
beforeAll(async () => {
  cookie = (await login("rows@x.com")).cookie;
});

it("publish, new version and index alarm write the #248 row counts", async () => {
  const html = (w: string) => `<!doctype html><p>${w} words here</p>`;
  rows.n = 0;
  const r = await api(A as never, R.artifacts, cookie, {
    method: "POST",
    body: { title: "Rows", format: "html", content: html("alpha") },
  });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: string };
  // artifacts insert 4 (table, pk, 2 live partials) + bump 3 + versions 2 + FTS seed 1.
  expect(rows.n).toBe(10);

  rows.n = 0;
  await indexVersionOrThrow(counted, id, 1);
  expect(rows.n).toBe(2); // one FTS write + text_indexed

  rows.n = 0;
  await indexVersionOrThrow(counted, id, 1);
  expect(rows.n).toBe(1); // unchanged text: no FTS write

  rows.n = 0;
  const v = await api(A as never, R.versions(id), cookie, {
    method: "POST",
    body: { format: "html", content: html("beta") },
  });
  expect(v.status).toBe(201);
  expect(rows.n).toBe(5); // bump 3 + versions 2

  rows.n = 0;
  await indexVersionOrThrow(counted, id, 2);
  expect(rows.n).toBe(2);
  const hit = await env.DB.prepare(
    "select body from artifact_search where artifact_id = ?",
  )
    .bind(id)
    .first<{ body: string }>();
  expect(hit?.body).toContain("beta");
});
