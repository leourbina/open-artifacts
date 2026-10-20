// Data-doc write CPU per plan (env PLAN): 256 KB on Free must fit the
// 10 ms budget (asserted, over a tiny write: local D1/DO I/O cancels out;
// interleaved pairs, bound scaled to the runner by the tiny write's own time);
// a 1 MB doc on Paid is accepted and its cost reported. A count over a
// 5000-doc collection costs < 10 ms over one of an empty collection.
// Runs serially via vitest.cpu.config.ts (median of 7); the report row is an
// annotation: pnpm test:cpu -- test/data-doc.cpu.test.ts --reporter=verbose
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIMITS, type Member, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { calibrated, medianMs, pairedMs } from "./cpu-time.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const FREE = { ...(env as Env), PLAN: undefined } as Env;
const PAID = { ...(env as Env), PLAN: "paid" } as Env;
let owner: { cookie: string; member: Member };

/** Local median of a tiny doc write (dev laptop, 2026-10-20). */
const TINY_WRITE_REF_MS = 3;
/** Local median of a count over an empty collection (dev laptop, 2026-10-20). */
const EMPTY_COUNT_REF_MS = 3;

beforeAll(async () => {
  const l = await login("data-doc-cpu@x.com");
  const m = await getUser(env as Env, l.userId);
  if (!m) throw new Error("no user");
  owner = { cookie: l.cookie, member: m };
});

async function art(e: Env): Promise<string> {
  const id = (
    await publish(
      env as Env,
      owner.member,
      {
        title: "cpu",
        format: "html",
        content: "<p>x</p>",
        capabilities: { db: true, viewer: false, storage: false },
      } as never,
      null,
    )
  ).id;
  await runInDurableObject(
    runtimeStub(e, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => {
      (i as unknown as { env: Env }).env = e;
    },
  );
  return id;
}

/** PUT of an escape-light doc whose minified JSON is `bytes`. */
const put = (id: string, bytes: number, e: Env) => {
  const body = JSON.stringify({ text: "x".repeat(bytes - 11) });
  let n = 0;
  return async () => {
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.dataDoc(id, "c", `d${n++ % 2}`)}`, {
        method: "PUT",
        headers: {
          cookie: owner.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body,
      }),
      e,
    );
    expect(r.status).toBe(200);
    await r.body?.cancel();
  };
};

/** GET R.dataCount; asserts the expected count. */
const count = (id: string, col: string, want: number, e: Env) => async () => {
  const r = await fetchAndWait(
    app,
    new Request(`http://app.localhost${R.dataCount(id, col)}`, {
      headers: { cookie: owner.cookie },
    }),
    e,
  );
  expect(r.status).toBe(200);
  expect(((await r.json()) as { count: number }).count).toBe(want);
};

describe("data count CPU", () => {
  it("Free: count of a 5000-doc collection costs < 10 ms over an empty one", async ({
    annotate,
  }) => {
    const id = await art(FREE);
    await runInDurableObject(
      runtimeStub(FREE, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (i) => {
        const sql = (i as unknown as { ctx: DurableObjectState }).ctx.storage
          .sql;
        // Bodies as large as list pages would read: count must not touch them.
        const data = JSON.stringify({ text: "x".repeat(1000) });
        sql.exec(
          `with recursive n(i) as (select 0 union all select i + 1 from n where i < 4999)
           insert into docs (collection, id, data, size, updated_at, updated_by)
           select 'big', 'd' || i, ?, ?, '2026-10-20T00:00:00.000Z', null from n`,
          data,
          data.length,
        );
      },
    );
    const t = await pairedMs(
      count(id, "empty", 0, FREE),
      count(id, "big", 5000, FREE),
    );
    await calibrated(annotate, "count of 5000 docs over an empty one", {
      ms: t.delta,
      baseMs: t.base,
      refMs: EMPTY_COUNT_REF_MS,
      maxMs: 10,
    });
  });
});

describe("data-doc write CPU", () => {
  it("Free: a 256 KB doc write costs < 10 ms over a tiny one", async ({
    annotate,
  }) => {
    const id = await art(FREE);
    const t = await pairedMs(
      put(id, 64, FREE),
      put(id, LIMITS.dataDocBytesFree, FREE),
    );
    await calibrated(annotate, "256 KB doc write over a tiny one", {
      ms: t.delta,
      baseMs: t.base,
      refMs: TINY_WRITE_REF_MS,
      maxMs: 10,
    });
  });

  it("report: Paid 1 MB doc write", async ({ annotate }) => {
    const id = await art(PAID);
    const tiny = await medianMs(put(id, 64, PAID));
    const full = await medianMs(put(id, LIMITS.dataDocBytesPaid, PAID));
    await annotate(`${full} ms  Paid: 1 MB doc write (tiny: ${tiny} ms)`);
  });
});
