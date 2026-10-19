// Report only (annotations, no assertion): inline publish wall time in local
// workerd per candidate Free inline limit, worst-case escape-heavy content,
// against a tiny publish (local D1/R2 I/O, off-isolate in production, is in
// both). Informs a Free inline limit; it changes none.
// pnpm test:cpu -- test/publish-candidates.cpu.test.ts --reporter=verbose
import { R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { api, login } from "./helpers.js";

const app = createApp();
let cookie: string;
const escapeHeavy = (bytes: number) =>
  `<p class="a\\b">${'"\\'.repeat(bytes / 2)}</p>`.slice(0, bytes);
const typical = (bytes: number) => {
  let s = "<!doctype html><title>t</title>";
  for (let i = 0; s.length < bytes; i++)
    s += `<div class="c${i % 9}"><p>row ${i} text &amp; more</p></div>\n`;
  return s.slice(0, bytes);
};

/** p50 and p95 wall ms over `runs` publishes of `content`, after 3 warm-ups. */
async function measure(content: string, runs = 30) {
  const one = async () => {
    const r = await api(app, R.artifacts, cookie, {
      method: "POST",
      body: { title: "cpu", format: "html", content },
    });
    expect(r.status).toBe(201);
    await r.body?.cancel();
  };
  for (let i = 0; i < 3; i++) await one();
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await one();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const q = (p: number) =>
    ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)] ?? 0;
  return { p50: q(0.5), p95: q(0.95) };
}

beforeAll(async () => {
  cookie = (await login("publish-candidates@x.com")).cookie;
});

describe("inline publish candidates (report)", () => {
  it("p50/p95 per size", async ({ annotate }) => {
    const rows: [string, string][] = [];
    const add = async (name: string, content: string) => {
      const { p50, p95 } = await measure(content);
      rows.push([name, `p50 ${p50} p95 ${p95}`]);
    };
    await add("tiny", "<p>x</p>");
    for (const kb of [64, 96, 128])
      await add(`${kb} KB escape-heavy`, escapeHeavy(kb * 1024 - 64));
    await add("120 KB typical html", typical(120 * 1024));
    for (const [k, v] of rows) await annotate(`${v}  ${k}`);
  }, 60_000);
});
