// /mcp CPU over the inline and data-doc limits, per plan (env PLAN).
// Free: the body cap (LIMITS.mcpBodyBytesFree, 320 KB) is checked before any
// read or parse, so an oversize call costs nothing but the auth lookup
// (asserted). Paid: the cap is a 1 MB doc + 64 KB, so an oversize publish
// under it is fully parsed before too_large (reported).
// Runs serially via vitest.cpu.config.ts (median of 5); the report rows are
// annotations: pnpm test:cpu -- test/mcp-publish.cpu.test.ts --reporter=verbose
import { env } from "cloudflare:workers";
import { LIMITS } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { medianMs } from "./cpu-time.js";
import { login } from "./helpers.js";
import { callWorker, MCP_URL } from "./mcp-helpers.js";

let pat: string;
const FREE = { ...(env as Env), PLAN: undefined } as Env;
const PAID = { ...(env as Env), PLAN: "paid" } as Env;
const escapeHeavy = (bytes: number) =>
  `<p class="a\\b">${'"\\'.repeat(bytes / 2)}</p>`.slice(0, bytes);

/** A publish_artifact call; `state.read` counts the body bytes pulled. */
const call = (args: Record<string, unknown>, e: Env) => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "publish_artifact", arguments: args },
    }),
  );
  const state = { read: 0 };
  const run = () => {
    state.read = 0;
    return callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${pat}`,
          "content-length": String(body.length),
        },
        body: new ReadableStream<Uint8Array>(
          {
            pull(c) {
              state.read += body.length;
              c.enqueue(body);
              c.close();
            },
          },
          { highWaterMark: 0 },
        ),
        duplex: "half",
      } as RequestInit),
      e,
    ).then((r) => r.text());
  };
  return { run, state, size: body.length };
};

beforeAll(async () => {
  const l = await login("mcp-publish-cpu@x.com");
  pat = (await createPat(env, l.userId, "cpu")).token;
});

describe("/mcp CPU", () => {
  it("Free: a body over 320 KB gets the error unread, < 5 ms over auth", async () => {
    const over = call(
      { title: "cpu", format: "html", content: escapeHeavy(250 * 1024) },
      FREE,
    );
    expect(over.size).toBeGreaterThan(LIMITS.mcpBodyBytesFree);
    expect(await over.run()).toContain("Request body exceeds 320 KB");
    expect(over.state.read).toBe(0);
    // Wall time includes the PAT lookup (local D1 I/O, off-isolate in
    // production): measure it with a call refused before any tool runs.
    const auth = await medianMs(
      call({ format: "html", content: "<p>x</p>" }, FREE).run,
    );
    // The real guard is read === 0; the 5 ms delta keeps whole-ms timer
    // ticks on a noisy runner from failing it.
    expect((await medianMs(over.run)) - auth).toBeLessThan(5);
  });

  it("report: medians per plan", async ({ annotate }) => {
    const big = escapeHeavy(250 * 1024);
    const rows: [string, number][] = [
      [
        "Free: 250 KB escape-heavy (~500 KB body) → 413 at the cap",
        await medianMs(
          call({ title: "cpu", format: "html", content: big }, FREE).run,
        ),
      ],
      [
        "Paid: 250 KB escape-heavy (~500 KB body) → too_large (full parse)",
        await medianMs(
          call({ title: "cpu", format: "html", content: big }, PAID).run,
        ),
      ],
      [
        "Paid: 500 KB escape-heavy (~1 MB body) → too_large (full parse)",
        await medianMs(
          call(
            { title: "cpu", format: "html", content: escapeHeavy(500 * 1024) },
            PAID,
          ).run,
        ),
      ],
      [
        "tiny invalid call (no title) → error",
        await medianMs(call({ format: "html", content: "<p>x</p>" }, FREE).run),
      ],
      [
        "tiny valid publish",
        await medianMs(
          call({ title: "cpu", format: "html", content: "<p>x</p>" }, FREE).run,
        ),
      ],
      [
        `${LIMITS.inlineBytes / 1024 - 8} KB escape-heavy valid publish`,
        await medianMs(
          call(
            {
              title: "cpu",
              format: "html",
              content: escapeHeavy(LIMITS.inlineBytes - 8 * 1024),
            },
            FREE,
          ).run,
        ),
      ],
    ];
    for (const [k, v] of rows) await annotate(`${v} ms  ${k}`);
  });
});
