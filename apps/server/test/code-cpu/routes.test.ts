// The CPU bar, half 2 (docs/ops/cpu-budget.md): CODE CPU ≤ 2 ms per route.
// Node proxy like scripts/bench.ts: the real Worker against in-process
// bindings, metered with the thread CPU clock minus D1/R2 shims and DO
// methods (DO rows meter the DO invocation itself). Per route: p95 of RUNS
// requests after warm-up, median of 5 such runs. Part of `pnpm test:cpu`.
import { LIMITS } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import {
  apiReq,
  type BenchEnv,
  type Ctx,
  call,
  htmlDoc,
  ok,
  type Scenario,
  sample,
  setup,
  summarize,
} from "../../scripts/bench.js";
import { meterDo } from "../../scripts/bench-env.js";
import type { ArtifactRuntime } from "../../src/runtime/do.js";

const BAR_MS = 2;
/**
 * The bar is in reference-machine ms (the dev laptop the rows in
 * docs/ops/cpu-budget.md came from). A slower runner (CI is about 3×) scales
 * it by its own `GET /api/v1/me` p95 versus REF_ME_MS. That's the same
 * harness and code path as the rows, which a synthetic workload under-
 * estimated (1.5× against 3.2×). Capped at MAX_SCALE so a pathological
 * runner can't hide a regression.
 */
const REF_ME_MS = 0.56;
const MAX_SCALE = 4;
const RUNS = 20;
const REPEATS = 5;
const APP = "http://app.localhost";

/** HTML where every content byte needs a JSON escape (`"` and `\`). */
const escapeHeavy = (bytes: number) =>
  `<p class="a\\b">${'"\\'.repeat(bytes / 2)}</p>`.slice(0, bytes);

let c: Ctx;
let bar = BAR_MS;
let scale = 1;
beforeAll(async () => {
  c = await setup();
  const me = routes().find((r) => r.name === "GET /api/v1/me");
  if (!me) throw new Error("no calibration scenario");
  scale = Math.min(MAX_SCALE, Math.max(1, (await p95Median(me)) / REF_ME_MS));
  bar = BAR_MS * scale;
}, 120_000);

/** p95 of RUNS requests after warm-up, median of REPEATS runs. */
async function p95Median(s: Scenario, p95s: number[] = []): Promise<number> {
  for (let i = 0; i < REPEATS; i++)
    p95s.push(summarize(s, await sample(s, RUNS, 5)).p95);
  p95s.sort((a, b) => a - b);
  return p95s[Math.floor(REPEATS / 2)] ?? Number.POSITIVE_INFINITY;
}

const json = (x: unknown) => JSON.stringify(x);
const req = (path: string, method = "GET", body?: string) =>
  apiReq(c.token, path, method, body);
/** The metered step; `r` is built per iteration in prepare (unmetered). */
const step = (env: BenchEnv, r: Request, what: string) => () =>
  call(env, r).then((x) => ok(x, what));

/** An upload (create, then PUT unless `put` is false); unmetered. */
async function upload(env: BenchEnv, page: string, put = true) {
  const up = (await (
    await ok(
      await call(
        env,
        req(
          "/api/v1/uploads",
          "POST",
          json({ path: "index.html", size: page.length }),
        ),
      ),
      "upload create",
    )
  ).json()) as { uploadId: string; artifactId: string; url: string };
  const u = new URL(up.url);
  const putReq = () =>
    new Request(`${APP}${u.pathname}${u.search}`, {
      method: "PUT",
      body: page,
      headers: { "content-length": String(page.length) },
    });
  if (put) await ok(await call(env, putReq()), "upload PUT");
  return { ...up, putReq };
}

function routes(): Scenario[] {
  const { env } = c;
  const page = htmlDoc(250 * 1024);
  const inline = json({
    title: "Escape-heavy",
    format: "html",
    content: escapeHeavy(LIMITS.inlineBytes - 64),
  });
  // Just under the Free data-doc limit (256 KB of JSON as received).
  const doc256 = json({
    text: "budget word ".repeat((LIMITS.dataDocBytesFree - 64) / 12),
  });
  let dataId = "";
  let docN = 0;
  let writes = 0;
  const w = (name: string, prepare: Scenario["prepare"]): Scenario => ({
    name,
    budgetMs: BAR_MS,
    bucket: "worker",
    prepare,
  });
  return [
    w("GET /healthz", async () =>
      step(env, new Request(`${APP}/healthz`), "healthz"),
    ),
    w("GET /api/v1/me", async () => step(env, req("/api/v1/me"), "me")),
    w("list 25", async () =>
      step(env, req("/api/v1/artifacts?limit=25"), "list"),
    ),
    w("search", async () =>
      step(env, req("/api/v1/search?q=budget%20note"), "search"),
    ),
    w("inline publish 128 KB escape-heavy", async () =>
      step(env, req("/api/v1/artifacts", "POST", inline), "publish inline"),
    ),
    w("upload create", async () =>
      step(
        env,
        req(
          "/api/v1/uploads",
          "POST",
          json({ path: "index.html", size: page.length }),
        ),
        "upload create",
      ),
    ),
    w("upload PUT 250 KB", async () => {
      const up = await upload(env, page, false);
      return step(env, up.putReq(), "upload PUT");
    }),
    w("publish { uploadId } 250 KB html", async () => {
      const up = await upload(env, page);
      return step(
        env,
        req(
          "/api/v1/artifacts",
          "POST",
          json({
            id: up.artifactId,
            title: "Big page",
            files: { "index.html": { uploadId: up.uploadId } },
          }),
        ),
        "publish upload",
      );
    }),
    ...(["worker", "do"] as const).map(
      (bucket): Scenario => ({
        name: `data doc write 256 KB (${bucket})`,
        budgetMs: BAR_MS,
        bucket,
        prepare: async () => {
          if (!dataId) {
            const r = await ok(
              await call(
                env,
                req(
                  "/api/v1/artifacts",
                  "POST",
                  json({
                    title: "db",
                    format: "html",
                    content: "<p>live</p>",
                    capabilities: { db: true },
                  }),
                ),
              ),
              "publish db",
            );
            dataId = ((await r.json()) as { id: string }).id;
          }
          // The DO allows 100 writes/min per actor: move its clock a minute every 90.
          const obj = env.ARTIFACT_RUNTIME.instance(dataId)
            .obj as unknown as ArtifactRuntime;
          const minute = Math.floor(writes++ / 90);
          obj.now = () => Date.now() + minute * 60_000;
          return step(
            env,
            req(
              `/api/v1/artifacts/${dataId}/data/c/d${docN++ % 20}`,
              "PUT",
              doc256,
            ),
            "data write",
          );
        },
      }),
    ),
    {
      name: "index alarm 64 KB html (do)",
      budgetMs: BAR_MS,
      bucket: "do",
      prepare: async () => {
        const r = await ok(
          await call(
            env,
            req(
              "/api/v1/artifacts",
              "POST",
              json({ title: "A", format: "html", content: htmlDoc(64 * 1024) }),
            ),
          ),
          "publish",
        );
        const { id } = (await r.json()) as { id: string };
        const obj = env.ARTIFACT_RUNTIME.instance(id)
          .obj as unknown as ArtifactRuntime;
        if (!obj.pendingIndex()) throw new Error("nothing pending to index");
        return async () => {
          await meterDo(() => obj.alarm());
          if (obj.pendingIndex()) throw new Error("alarm did not index");
        };
      },
    },
  ];
}

describe(`code CPU ≤ ${BAR_MS} ms per route (p95, median of ${REPEATS})`, () => {
  const names = [
    "GET /healthz",
    "GET /api/v1/me",
    "list 25",
    "search",
    "inline publish 128 KB escape-heavy",
    "upload create",
    "upload PUT 250 KB",
    "publish { uploadId } 250 KB html",
    "data doc write 256 KB (worker)",
    "data doc write 256 KB (do)",
    "index alarm 64 KB html (do)",
  ];
  for (const name of names)
    it(name, async ({ annotate }) => {
      const s = routes().find((r) => r.name === name);
      if (!s) throw new Error(`no scenario ${name}`);
      const p95s: number[] = [];
      const median = await p95Median(s, p95s);
      await annotate(
        `p95 ${median.toFixed(2)} ms, bar ${bar.toFixed(2)} (×${scale.toFixed(2)}) (runs: ${p95s.map((x) => x.toFixed(2)).join(", ")})`,
      );
      expect(median).toBeLessThanOrEqual(bar);
    }, 120_000);
});
