import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, parseSeed, run } from "./reset.js";

const TOKEN = "oa_pat_secretsecretsecret";
const SEED = {
  art1: { collections: { todos: { a: { done: false } }, empty: {} } },
  art2: { collections: {} },
};
let dir: string;
let seedPath: string;
let tokenFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "demo-reset-"));
  seedPath = join(dir, "seed.json");
  tokenFile = join(dir, "token");
  writeFileSync(seedPath, JSON.stringify(SEED));
  writeFileSync(tokenFile, `${TOKEN}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { url: string; init: RequestInit };
const fakeFetch = (calls: Call[], respond: (u: string) => Response) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url);
  }) as unknown as typeof fetch;

describe("demo reset script", () => {
  it("dry run by default: no requests, no token needed", async () => {
    const calls: Call[] = [];
    const out: string[] = [];
    const o = parseArgs([seedPath, "--base-url", "https://x.example"], {});
    expect(o.apply).toBe(false);
    const code = await run(
      o,
      {},
      (l) => out.push(l),
      fakeFetch(calls, () => new Response("{}")),
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(out[0]).toMatch(
      /^would reset art1: 2 collections, 1 docs, \d+ bytes$/,
    );
    expect(out.at(-1)).toContain("dry run");
  });

  it("--apply PUTs each snapshot with the token file; never prints the token", async () => {
    const calls: Call[] = [];
    const out: string[] = [];
    const o = parseArgs(
      [
        seedPath,
        "--base-url",
        "https://x.example/ignored",
        "--token-file",
        tokenFile,
        "--apply",
      ],
      {},
    );
    const code = await run(
      o,
      {},
      (l) => out.push(l),
      fakeFetch(calls, (u) =>
        u.includes("art2")
          ? new Response(`{"error":{"message":"echo ${TOKEN}"}}`, {
              status: 404,
            })
          : new Response('{"collections":2,"docs":1}'),
      ),
    );
    expect(code).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([
      "https://x.example/api/v1/artifacts/art1/data",
      "https://x.example/api/v1/artifacts/art2/data",
    ]);
    expect(calls[0]?.init.method).toBe("PUT");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(SEED.art1);
    expect(out.join("\n")).not.toContain(TOKEN);
    expect(out.join("\n")).toContain("FAILED art2: HTTP 404");
  });

  it("OA_TOKEN and OA_URL work; --apply without a token fails", async () => {
    const o = parseArgs([seedPath, "--apply"], { OA_URL: "https://y.example" });
    expect(o.baseUrl).toBe("https://y.example");
    await expect(run(o, {}, () => {})).rejects.toThrow(/no token/);
    const calls: Call[] = [];
    expect(
      await run(
        o,
        { OA_TOKEN: TOKEN },
        () => {},
        fakeFetch(calls, () => new Response("{}")),
      ),
    ).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("rejects bad seeds and non-https URLs", () => {
    expect(() => parseSeed("[]")).toThrow(/seed must be an object/);
    expect(() => parseSeed('{"a":{"collections":{"bad name":{}}}}')).toThrow(
      /invalid collection/,
    );
    expect(() => parseSeed('{"a":{"collections":{"c":{"x.y":1}}}}')).toThrow(
      /invalid doc id/,
    );
    expect(() => parseSeed('{"a":{"docs":{}}}')).toThrow(/collections/);
    expect(() =>
      parseArgs([seedPath, "--base-url", "http://x.example"], {}),
    ).toThrow(/https/);
    expect(() => parseArgs([seedPath], {})).toThrow(/base-url/);
  });
});
