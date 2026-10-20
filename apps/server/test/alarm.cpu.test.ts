// Index-alarm wall-clock budget in local workerd (docs/ops/cpu-budget.md):
// one alarm indexes one version (D1 read, <= 64 KB R2 range read,
// extractText, one D1 batch). Local D1/R2 I/O is included and CI runners are
// noisy, so the absolute time is a report (budget(): asserted only under
// test:cpu:strict). The gate is the size-dependent part (64 KB minus a tiny
// entry, measured interleaved, median of 7 pairs), bounded at 10 ms scaled to
// the runner by the tiny alarm's own time (scaledBound). It still catches a
// parser blow-up; code CPU is pinned tightly by test/code-cpu (Node, thread
// CPU). Runs serially via vitest.cpu.config.ts.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Member } from "@oa/shared";
import { beforeAll, describe, it } from "vitest";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { budget, calibrated, pairedMs } from "./cpu-time.js";
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

/** One run of the index alarm for a new artifact's current version. */
async function alarm(format: string, content: string) {
  const { id, version } = await publish(
    env as Env,
    owner,
    { title: "alarm", format, content } as never,
    null,
  );
  const stub = runtimeStub(env as Env, id);
  return async () => {
    await stub.scheduleIndex(id, version);
    await runDurableObjectAlarm(
      stub as unknown as DurableObjectStub<ArtifactRuntime>,
    );
  };
}

/** Local median of the tiny-entry alarm (dev laptop, 2026-10-20). */
const TINY_REF_MS = 6;

describe("index alarm CPU", () => {
  it("indexing a 64 KB html or markdown entry costs < 10 ms over a tiny one", async ({
    annotate,
  }) => {
    const tiny = await alarm("html", "<p>x</p>");
    for (const [format, content] of [
      ["html", html(64 * 1024)],
      ["markdown", md(64 * 1024)],
    ] as const) {
      const t = await pairedMs(tiny, await alarm(format, content));
      await budget(annotate, `64 KB ${format} alarm`, t.ms, 15);
      await calibrated(annotate, `${format} alarm over a tiny entry`, {
        ms: t.delta,
        baseMs: t.base,
        refMs: TINY_REF_MS,
        maxMs: 10,
      });
    }
  });
});
