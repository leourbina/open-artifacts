// Opt-in: index-alarm CPU (DO bucket) for a 64 KB HTML and a 64 KB markdown
// entry. BENCH_ALARM=1 pnpm --filter @oa/server bench
import { describe, expect, it } from "vitest";
import {
  apiReq,
  call,
  htmlDoc,
  ok,
  type Scenario,
  sample,
  setup,
  summarize,
  table,
} from "../../scripts/bench.js";
import { meterDo } from "../../scripts/bench-env.js";
import type { ArtifactRuntime } from "../../src/runtime/do.js";

describe.skipIf(!process.env.BENCH_ALARM)("index alarm CPU", () => {
  it("reports p50/p95 per entry kind", async () => {
    const { env, token } = await setup();
    const md = (bytes: number) => {
      let s = "# Notes\n\n";
      for (let i = 0; s.length < bytes; i++)
        s += `## Section ${i}\n\nSome **bold** text, a [link](https://x.test/${i}) and \`code\`.\n\n`;
      return s.slice(0, bytes);
    };
    const kinds: [string, string, string][] = [
      ["64 KB html", "html", htmlDoc(64 * 1024)],
      ["64 KB markdown", "markdown", md(64 * 1024)],
    ];
    const results = [];
    for (const [name, format, content] of kinds) {
      const s: Scenario = {
        name: `DO alarm: index ${name}`,
        budgetMs: 10,
        bucket: "do",
        info: true,
        prepare: async () => {
          const r = await ok(
            await call(
              env,
              apiReq(
                token,
                "/api/v1/artifacts",
                "POST",
                JSON.stringify({ title: "A", format, content }),
              ),
            ),
            "publish",
          );
          const { id } = (await r.json()) as { id: string };
          const obj = (
            env.ARTIFACT_RUNTIME as unknown as {
              instance(id: string): { obj: unknown };
            }
          ).instance(id).obj as ArtifactRuntime;
          return async () => {
            await meterDo(() => obj.alarm());
            if (obj.pendingIndex()) throw new Error("alarm did not index");
          };
        },
      };
      // BENCH_ALARM=cold: the first alarm in this process (no warm-up, no gc):
      // what a fresh isolate pays (lazy compilation of the index path).
      const cold = process.env.BENCH_ALARM === "cold";
      results.push(
        summarize(
          s,
          await sample(cold ? { ...s, cold: true } : s, cold ? 1 : undefined),
        ),
      );
    }
    process.stderr.write(`\n${table(results)}\n\n`);
    expect(results).toHaveLength(2);
  });
});
