/**
 * Publish and list CPU profile (opt-in, Node proxy like scripts/bench.ts):
 *   BENCH_PUBLISH=1 pnpm --filter @oa/server bench
 * Per-request CPU (p50/p95) for inline publishes (typical HTML and worst-case
 * escape-heavy at several sizes), the upload path split into its three
 * requests, and list 25; plus a sampled profile of the hottest scenarios.
 */
import { Session } from "node:inspector/promises";
import path from "node:path";
import { LIMITS } from "@oa/shared";
import {
  apiReq,
  call,
  htmlDoc,
  ok,
  type Result,
  type Scenario,
  sample,
  setup,
  summarize,
  table,
} from "./bench.js";

const APP = "http://app.localhost";

/** HTML where every content byte needs a JSON escape (`"` and `\`). */
const escapeHeavy = (bytes: number) =>
  `<p class="a\\b">${'"\\'.repeat(bytes / 2)}</p>`.slice(0, bytes);

type Profile = {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    hitCount?: number;
  }[];
};

/** Busy self time by function, top `n` (idle and program excluded). */
function top(p: Profile, n = 12): string[] {
  const by = new Map<string, number>();
  let total = 0;
  for (const x of p.nodes) {
    const h = x.hitCount ?? 0;
    const f = x.callFrame.functionName;
    if (!h || f === "(idle)") continue;
    total += h;
    const u = x.callFrame.url;
    const where = u.includes("node_modules")
      ? (/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(
          u,
        )?.[1] ?? "dep")
      : path.basename(u);
    const k = `${f || "(anon)"} ${where}${u && !u.includes("node_modules") ? `:${x.callFrame.lineNumber + 1}` : ""}`;
    by.set(k, (by.get(k) ?? 0) + h);
  }
  return [...by]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(
      ([k, v]) =>
        `  ${((100 * v) / (total || 1)).toFixed(1).padStart(5)}%  ${k}`,
    );
}

export async function runPublishBench(): Promise<string> {
  const c = await setup();
  const { env, token } = c;
  const publish = (input: unknown) =>
    apiReq(token, "/api/v1/artifacts", "POST", JSON.stringify(input));
  const inline = (name: string, content: string, budgetMs = 10): Scenario => ({
    name,
    budgetMs,
    bucket: "worker",
    info: true,
    prepare: async () => {
      const req = publish({ title: "Bench", format: "html", content });
      return () => call(env, req).then((r) => ok(r, name));
    },
  });

  // The upload path, one request at a time.
  const page = htmlDoc(250 * 1024);
  const create = async () =>
    (await (
      await ok(
        await call(
          env,
          apiReq(
            token,
            "/api/v1/uploads",
            "POST",
            JSON.stringify({ path: "index.html", size: page.length }),
          ),
        ),
        "upload create",
      )
    ).json()) as { uploadId: string; artifactId: string; url: string };
  const putReq = (url: string) => {
    const u = new URL(url);
    return new Request(`${APP}${u.pathname}${u.search}`, {
      method: "PUT",
      body: page,
      headers: { "content-length": String(page.length) },
    });
  };
  const scenarios: Scenario[] = [
    {
      name: "list 25",
      budgetMs: 10,
      bucket: "worker",
      info: true,
      prepare: async () => {
        const req = apiReq(token, "/api/v1/artifacts?limit=25");
        return () => call(env, req).then((r) => ok(r, "list"));
      },
    },
    inline("inline 120 KB html (typical)", htmlDoc(120 * 1024)),
    ...[64, 96, 128].map((kb) =>
      inline(
        `inline ${kb} KB escape-heavy (worst case, ~${2 * kb} KB body)`,
        escapeHeavy(kb * 1024 - 64),
      ),
    ),
    {
      name: "upload path: create (POST /uploads)",
      budgetMs: 10,
      bucket: "worker",
      info: true,
      prepare: async () => {
        const req = apiReq(
          token,
          "/api/v1/uploads",
          "POST",
          JSON.stringify({ path: "index.html", size: page.length }),
        );
        return () => call(env, req).then((r) => ok(r, "create"));
      },
    },
    {
      name: "upload path: PUT 250 KB",
      budgetMs: 10,
      bucket: "worker",
      info: true,
      prepare: async () => {
        const up = await create();
        const req = putReq(up.url);
        return () => call(env, req).then((r) => ok(r, "PUT"));
      },
    },
    {
      name: "upload path: publish { uploadId } (250 KB html)",
      budgetMs: 10,
      bucket: "worker",
      info: true,
      prepare: async () => {
        const up = await create();
        await ok(await call(env, putReq(up.url)), "PUT");
        const req = publish({
          id: up.artifactId,
          title: "Big page",
          files: { "index.html": { uploadId: up.uploadId } },
        });
        return () => call(env, req).then((r) => ok(r, "publish upload"));
      },
    },
  ];

  const results: Result[] = [];
  for (const s of scenarios) results.push(summarize(s, await sample(s)));
  const lines = [table(results), ""];

  // Sampled profiles (CPU only; one warm run each, 30 iterations).
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 50 });
  for (const s of [scenarios[0], scenarios[1], scenarios[4], scenarios[7]]) {
    if (!s) continue;
    const steps = [];
    for (let i = 0; i < 30; i++) steps.push(await s.prepare());
    await session.post("Profiler.start");
    for (const step of steps) await step();
    const { profile } = (await session.post("Profiler.stop")) as {
      profile: Profile;
    };
    lines.push(`Profile: ${s.name}`, ...top(profile), "");
  }
  session.disconnect();
  lines.push(`(LIMITS.inlineBytes = ${LIMITS.inlineBytes / 1024} KB)`);
  return lines.join("\n");
}

/**
 * Inline publish CPU per size (32–128 KB), escape-heavy (worst case) and
 * plain HTML: request p50/p95 (worker CPU, as bench.ts), and the median CPU
 * of the request's body work measured alone on the same body: UTF-8 decode +
 * JSON.parse, and the PublishInput schema parse. Publish does no hashing.
 */
export async function runInlineCandidates(): Promise<string> {
  const { PublishInputSchema } = await import("@oa/shared");
  const { cpuMicros } = await import("./bench-env.js");
  const c = await setup();
  const { env, token } = c;
  const dec = new TextDecoder();
  const medianUs = (f: () => void, n = 50) => {
    for (let i = 0; i < 5; i++) f();
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = cpuMicros();
      f();
      xs.push(cpuMicros() - t);
    }
    xs.sort((a, b) => a - b);
    return xs[Math.floor(n / 2)] ?? 0;
  };
  const rows = [
    "| size | content | body KB | p50 ms | p95 ms | decode+JSON.parse ms | schema ms | rest ms (p50) |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const kb of [32, 64, 96, 128])
    for (const [kind, content] of [
      ["escape-heavy", escapeHeavy(kb * 1024 - 64)],
      ["plain html", htmlDoc(kb * 1024 - 64)],
    ] as const) {
      const body = new TextEncoder().encode(
        JSON.stringify({ title: "Bench", format: "html", content }),
      );
      const s: Scenario = {
        name: `${kb} KB ${kind}`,
        budgetMs: 10,
        bucket: "worker",
        info: true,
        prepare: async () => {
          const req = apiReq(token, "/api/v1/artifacts", "POST", body);
          return () => call(env, req).then((r) => ok(r, s.name));
        },
      };
      const r = summarize(s, await sample(s));
      const parseMs = medianUs(() => JSON.parse(dec.decode(body))) / 1000;
      const obj = JSON.parse(dec.decode(body));
      const schemaMs = medianUs(() => PublishInputSchema.safeParse(obj)) / 1000;
      rows.push(
        `| ${kb} KB | ${kind} | ${(body.length / 1024).toFixed(0)} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${parseMs.toFixed(2)} | ${schemaMs.toFixed(2)} | ${(r.p50 - parseMs - schemaMs).toFixed(2)} |`,
      );
    }
  return rows.join("\n");
}
