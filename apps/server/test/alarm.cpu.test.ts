// Index-alarm wall-clock budget in local workerd (docs/ops/cpu-budget.md):
// one alarm indexes one version (D1 read, ≤ 64 KB R2 range read,
// extractText, one D1 batch). Median of 5 per entry kind. Local D1/R2 I/O
// is included and CI runners are noisy, so the absolute time is a report
// (budget(): asserted only under test:cpu:strict). The gate is the
// size-dependent part (64 KB minus a tiny entry), which measured 6 ms on a CI
// runner (~3x slower than a laptop), bounded at 10 ms: it still catches a
// parser blow-up, and code CPU is pinned tightly by test/code-cpu (Node,
// thread CPU). Runs serially via vitest.cpu.config.ts.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Member } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { budget, medianMs } from "./cpu-time.js";
import { login } from "./helpers.js";

let owner: Member;
beforeAll(async () => {
  const l = await login("alarm-cpu@x.com");
  const m = await getUser(env as Env, l.userId);
  if (!m) throw new Error("no user");
  owner = m;
});

const html = (bytes: number) => {
  let s = "<!doctype html><title>t</title><body>";
  for (let i = 0; s.length < bytes; i++)
    s += `<div class="c${i % 9}"><p>row ${i} text &amp; <b>more</b></p></div>\n`;
  return s.slice(0, bytes);
};
const md = (bytes: number) => {
  let s = "# Notes\n\n";
  for (let i = 0; s.length < bytes; i++)
    s += `## Section ${i}\n\nSome **bold** text, a [link](https://x.test/${i}) and \`code\`.\n\n`;
  return s.slice(0, bytes);
};

/** Median wall ms of the index alarm for one artifact's current version. */
async function alarmMs(format: string, content: string) {
  const { id, version } = await publish(
    env as Env,
    owner,
    { title: "alarm", format, content } as never,
    null,
  );
  const stub = runtimeStub(env as Env, id);
  return medianMs(async () => {
    await stub.scheduleIndex(id, version);
    await runDurableObjectAlarm(
      stub as unknown as DurableObjectStub<ArtifactRuntime>,
    );
  });
}

describe("index alarm CPU", () => {
  it("indexing a 64 KB html or markdown entry stays near the 10 ms budget", async ({
    annotate,
  }) => {
    const tiny = await alarmMs("html", "<p>x</p>");
    await annotate(`${tiny} ms  tiny html entry`);
    for (const [format, content] of [
      ["html", html(64 * 1024)],
      ["markdown", md(64 * 1024)],
    ] as const) {
      const ms = await alarmMs(format, content);
      await budget(annotate, `64 KB ${format} alarm`, ms, 15);
      expect(ms - tiny, `${format} alarm over a tiny entry`).toBeLessThan(10);
    }
  });
});
