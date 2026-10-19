// Report only (no assertion): MCP publish_artifact over the inline limit.
// The MCP body cap (MAX_MCP_BODY) is set by the 1 MB artifact_data_set
// document, so an oversize escape-heavy publish_artifact is read and fully
// JSON-parsed (JSON-RPC envelope, then the tool's input schema) before
// planFiles answers too_large. These medians size that cost.
// Runs serially via vitest.cpu.config.ts (median of 5); the medians are
// annotations: pnpm test:cpu -- test/mcp-publish.cpu.test.ts --reporter=verbose
import { env } from "cloudflare:workers";
import { LIMITS } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { medianMs } from "./cpu-time.js";
import { login } from "./helpers.js";
import { callWorker, MCP_URL } from "./mcp-helpers.js";

let pat: string;
const escapeHeavy = (bytes: number) =>
  `<p class="a\\b">${'"\\'.repeat(bytes / 2)}</p>`.slice(0, bytes);
const call = (args: Record<string, unknown>) => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "publish_artifact", arguments: args },
  });
  return () =>
    callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${pat}`,
          "content-length": String(new TextEncoder().encode(body).length),
        },
        body,
      }),
    ).then((r) => r.text());
};

beforeAll(async () => {
  const l = await login("mcp-publish-cpu@x.com");
  pat = (await createPat(env, l.userId, "cpu")).token;
});

describe("MCP publish_artifact CPU (report)", () => {
  it("logs medians: oversize escape-heavy vs baselines", async ({
    annotate,
  }) => {
    const big = escapeHeavy(250 * 1024);
    const over = call({ title: "cpu", format: "html", content: big });
    const out = await over();
    expect(out).toContain("too_large");
    const rows: [string, number][] = [
      ["250 KB escape-heavy (~500 KB body) → too_large", await medianMs(over)],
      [
        "500 KB escape-heavy (~1 MB body) → too_large",
        await medianMs(
          call({
            title: "cpu",
            format: "html",
            content: escapeHeavy(500 * 1024),
          }),
        ),
      ],
      [
        "tiny invalid call (no title) → error",
        await medianMs(call({ format: "html", content: "<p>x</p>" })),
      ],
      [
        "tiny valid publish",
        await medianMs(
          call({ title: "cpu", format: "html", content: "<p>x</p>" }),
        ),
      ],
      [
        `${LIMITS.inlineBytes / 1024 - 8} KB escape-heavy valid publish`,
        await medianMs(
          call({
            title: "cpu",
            format: "html",
            content: escapeHeavy(LIMITS.inlineBytes - 8 * 1024),
          }),
        ),
      ],
    ];
    // Shown by the reporter (an annotation), since passing tests' logs are not.
    for (const [k, v] of rows) await annotate(`${v} ms  ${k}`);
  });
});
