// Inline publish wall-clock budget (global 10 ms; docs/ops/cpu-budget.md).
// The request's cost is JSON.parse of the body, worst for escape-heavy text:
// LIMITS.inlineBytes (128 KB) bounds it, and a body past the inline-derived
// cap is refused from its Content-Length, before it is read or parsed.
// Runs serially via vitest.cpu.config.ts (median of 5). Absolute times are
// reports (budget(): asserted only under test:cpu:strict); the gates are the
// cost over a tiny publish and the unread-body checks.
import { LIMITS, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { budget, medianMs } from "./cpu-time.js";
import { api, errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
let cookie: string;

/** HTML whose every byte needs a JSON escape: `"` and `\` (a 2× JSON body). */
const escapeHeavy = (bytes: number) =>
  `<p class="a\\b">${'"\\'.repeat(bytes / 2)}</p>`.slice(0, bytes);

beforeAll(async () => {
  cookie = (await login("publish-cpu@x.com")).cookie;
});

describe("inline publish CPU", () => {
  it("a 128 KB escape-heavy HTML publish costs under 10 ms over a tiny one", async () => {
    const content = escapeHeavy(LIMITS.inlineBytes);
    expect(JSON.stringify(content).length).toBeGreaterThan(
      1.9 * LIMITS.inlineBytes,
    );
    let status = 0;
    const ms = await medianMs(async () => {
      const r = await api(app, R.artifacts, cookie, {
        method: "POST",
        body: { title: "cpu", format: "html", content },
      });
      status = r.status;
      await r.body?.cancel();
    });
    expect(status).toBe(201);
    const tiny = await medianMs(async () => {
      const r = await api(app, R.artifacts, cookie, {
        method: "POST",
        body: { title: "cpu", format: "html", content: "<p>x</p>" },
      });
      await r.body?.cancel();
    });
    // Wall time here includes local D1/R2 I/O (off-isolate in production), the
    // same for both: the difference is the body's cost (read, parse, checks).
    expect(ms - tiny).toBeLessThan(10);
  });

  /** POST of `content` with Content-Length; counts reads of the body stream. */
  const sender = (content: string) => {
    const body = new TextEncoder().encode(
      JSON.stringify({ title: "cpu", format: "html", content }),
    );
    const state = { pulls: 0 };
    const send = () =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${R.artifacts}`, {
          method: "POST",
          headers: {
            cookie,
            "x-oa-request": "1",
            "content-type": "application/json",
            "content-length": String(body.length),
          },
          body: new ReadableStream<Uint8Array>(
            {
              pull(c) {
                state.pulls++;
                c.enqueue(body);
                c.close();
              },
            },
            { highWaterMark: 0 },
          ),
          duplex: "half",
        } as RequestInit),
      );
    return { send, state, size: body.length };
  };

  for (const kb of [250, 200])
    it(`a ${kb} KB escape-heavy body is refused with 413 before it is read`, async ({
      annotate,
    }) => {
      const { send, state, size } = sender(escapeHeavy(kb * 1024));
      expect(size).toBeGreaterThan(2 * LIMITS.inlineBytes + 64 * 1024);
      const r = await send();
      expect(r.status).toBe(413);
      expect((await errOf(r)).code).toBe("too_large");
      expect(state.pulls).toBe(0);
      const ms = await medianMs(async () => {
        await (await send()).body?.cancel();
      });
      // The gate is pulls === 0 (the body is never read); the time is a report.
      await budget(annotate, `${kb} KB escape-heavy 413`, ms, 2);
    });

  it("250 KB of plain text fits the body cap: one cheap parse, then 413", async ({
    annotate,
  }) => {
    const { send, state } = sender("a".repeat(250 * 1024));
    const r = await send();
    expect(r.status).toBe(413);
    expect(state.pulls).toBe(1);
    const ms = await medianMs(async () => {
      await (await send()).body?.cancel();
    });
    await budget(annotate, "250 KB plain-text 413", ms, 5);
  });
});
