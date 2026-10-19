// Data-doc write CPU per plan (env PLAN): 256 KB on Free must fit the
// 10 ms budget (asserted, over a tiny write: local D1/DO I/O cancels out);
// a 1 MB doc on Paid is accepted and its cost reported.
// Runs serially via vitest.cpu.config.ts (median of 5); the report row is an
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
import { medianMs } from "./cpu-time.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const FREE = { ...(env as Env), PLAN: undefined } as Env;
const PAID = { ...(env as Env), PLAN: "paid" } as Env;
let owner: { cookie: string; member: Member };

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

describe("data-doc write CPU", () => {
  it("Free: a 256 KB doc write costs < 10 ms over a tiny one", async () => {
    const id = await art(FREE);
    const tiny = await medianMs(put(id, 64, FREE));
    const full = await medianMs(put(id, LIMITS.dataDocBytesFree, FREE));
    expect(full - tiny).toBeLessThan(10);
  });

  it("report: Paid 1 MB doc write", async ({ annotate }) => {
    const id = await art(PAID);
    const tiny = await medianMs(put(id, 64, PAID));
    const full = await medianMs(put(id, LIMITS.dataDocBytesPaid, PAID));
    await annotate(`${full} ms  Paid: 1 MB doc write (tiny: ${tiny} ms)`);
  });
});
