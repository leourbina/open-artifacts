/**
 * Thumbnail capture CPU bench (opt-in; needs a local Chromium):
 *   THUMBS_BENCH_CHROME=/path/to/chrome-headless-shell \
 *     pnpm --filter @oa/server bench -- thumbs
 *
 * Runs the real captureThumbnail (services/thumbs.ts) in Node against a local
 * headless Chromium, so the capture's own CPU (the alarm's, in production) is
 * metered with the thread CPU clock like scripts/bench.ts. Kept off the
 * metered thread: the content host (scripts/bench-static.mjs, a child process
 * serving pages prefetched from the real content app) and Chromium itself.
 * D1/R2 shim time is excluded by meterDo. On the thread but native in
 * workerd: the WebSocket frame parser (undici here), reported separately in
 * the profile breakdown.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { type Member, newId } from "@oa/shared";
import { signContent } from "../src/content/signing.js";
import { getDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { publish } from "../src/services/artifacts.js";
import { captureThumbnail, THUMB } from "../src/services/thumbs.js";
import { getUser } from "../src/services/users.js";
import { makeEnv } from "./bench.js";
import { execCtx, installGlobals, meter, meterDo } from "./bench-env.js";

const here = (p: string) => new URL(p, import.meta.url).pathname;
const RENDER = here("../../../packages/render/dist");
const RUNTIME = here("../../../packages/runtime/dist");
const CONTENT = "http://content.localhost";

/** Serves the built render/runtime bundles, as dist-assets/_oa does in production. */
const assets = {
  fetch: async (req: Request) => {
    const p = new URL(req.url).pathname;
    const file =
      p === "/_oa/manifest.json"
        ? path.join(RENDER, "manifest.json")
        : p === "/_oa/runtime.manifest.json"
          ? path.join(RUNTIME, "runtime.manifest.json")
          : null;
    if (!file) return new Response("not found", { status: 404 });
    return new Response(readFileSync(file), {
      headers: { "content-type": "application/json" },
    });
  },
};

// ------------------------------------------------------------- artifacts

const para = (i: number) =>
  `Paragraph ${i}: the quarterly plan covers onboarding, billing and the new agent workflow. ` +
  "Each milestone lists an owner, a date and the risk we accept if it slips. ".repeat(
    3,
  );

const MARKDOWN = [
  "# Launch plan",
  "",
  ...Array.from({ length: 6 }, (_, i) => `## Section ${i + 1}\n\n${para(i)}\n`),
  "| Milestone | Owner | Date |",
  "| --- | --- | --- |",
  ...Array.from(
    { length: 8 },
    (_, i) => `| M${i} | team ${i} | 2026-11-${10 + i} |`,
  ),
  "",
  "```ts",
  "export function total(xs: number[]): number {",
  "  return xs.reduce((a, b) => a + b, 0);",
  "}",
  "```",
].join("\n");

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Landing</title>
<style>body{font:16px system-ui;margin:0}header{background:#1d4ed8;color:#fff;padding:48px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:48px}
.card{border:1px solid #ddd;border-radius:12px;padding:24px}</style></head><body>
<header><h1>Ship faster</h1><p>${para(0)}</p></header>
<section class="grid">${Array.from({ length: 9 }, (_, i) => `<div class="card"><h3>Feature ${i}</h3><p>${para(i)}</p></div>`).join("")}</section>
<script>document.querySelectorAll(".card").forEach((c,i)=>c.dataset.i=i)</script>
</body></html>`;

const CODE = Array.from(
  { length: 40 },
  (_, i) =>
    `/** Step ${i}. */\nexport async function step${i}(input: string): Promise<number> {\n  const n = input.length * ${i};\n  return n > 10 ? n : step${i}(input + "x");\n}\n`,
).join("\n");

/** A one-page PDF with some text (valid xref, so pdf.js renders it). */
function pdf(): string {
  const text = Array.from(
    { length: 30 },
    (_, i) =>
      `BT /F1 12 Tf 72 ${760 - i * 22} Td (Line ${i}: quarterly report figures) Tj ET`,
  ).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const ARTIFACTS = [
  { format: "markdown", content: MARKDOWN, entry: "README.md" },
  { format: "html", content: HTML, entry: "index.html" },
  { format: "code", content: CODE, entry: "main.ts", language: "typescript" },
  { format: "pdf", content: pdf(), entry: "document.pdf" },
] as const;

// ------------------------------------------------------------- browser

type Chrome = { proc: ChildProcess; ws: string };

async function launchChrome(chrome: string, port: number): Promise<Chrome> {
  const profile = mkdtempSync(path.join(tmpdir(), "oa-thumb-chrome-"));
  const proc = spawn(
    chrome,
    [
      "--headless",
      "--remote-debugging-port=0",
      `--host-resolver-rules=MAP content.localhost 127.0.0.1:${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const ws = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: proc.stderr as NodeJS.ReadableStream });
    rl.on("line", (l) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(l);
      if (m?.[1]) resolve(m[1]);
    });
    proc.on("exit", () => reject(new Error("chrome exited")));
  });
  return { proc, ws };
}

/**
 * The BROWSER binding, as @cloudflare/puppeteer uses it: POST
 * /v1/devtools/browser acquires (here: a fresh Chromium), the websocket
 * upgrade to /v1/devtools/browser/{id} connects to its DevTools socket.
 */
/** CDP traffic of the last capture: messages and bytes by method (events and replies). */
export const traffic = {
  in: new Map<string, { n: number; bytes: number }>(),
  out: 0,
  reset() {
    this.in.clear();
    this.out = 0;
  },
};
const METHOD = /"method":"([^"]+)"/;
function count(data: string, idToMethod: Map<number, string>) {
  const head = data.slice(0, 200);
  let k = METHOD.exec(head)?.[1];
  if (!k) {
    const id = Number(/"id":(\d+)/.exec(head)?.[1]);
    k = `reply:${idToMethod.get(id) ?? "?"}`;
  }
  const e = traffic.in.get(k) ?? { n: 0, bytes: 0 };
  e.n++;
  e.bytes += data.length;
  traffic.in.set(k, e);
}

function browserBinding(chrome: string, port: number) {
  const sessions = new Map<string, Chrome>();
  const all: Chrome[] = [];
  /** Spawned before the metered capture: Browser Run's acquire is remote. */
  let ready: Chrome | null = null;
  const binding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if (init?.method === "POST") {
        const c = ready ?? (await launchChrome(chrome, port));
        ready = null;
        const id = newId();
        sessions.set(id, c);
        all.push(c);
        return Response.json({ sessionId: id });
      }
      const c = sessions.get(u.pathname.split("/").pop() ?? "");
      if (!c) return new Response("no session", { status: 404 });
      const ws = new WebSocket(c.ws);
      const queue: string[] = [];
      const idToMethod = new Map<number, string>();
      ws.addEventListener("message", (e) => count(String(e.data), idToMethod));
      ws.addEventListener("open", () => {
        for (const m of queue.splice(0)) ws.send(m);
      });
      const socket = {
        accept() {},
        addEventListener: (t: string, h: (e: unknown) => void) =>
          ws.addEventListener(t, h as never),
        send: (m: string) => {
          traffic.out++;
          const id = Number(/"id":(\d+)/.exec(m)?.[1]);
          const method = METHOD.exec(m)?.[1];
          if (method) idToMethod.set(id, method);
          return ws.readyState === WebSocket.OPEN ? ws.send(m) : queue.push(m);
        },
        close: () => ws.close(),
      };
      return { status: 101, webSocket: socket } as unknown as Response;
    },
  };
  return {
    binding: binding as unknown as Fetcher,
    prepare: async () => {
      ready = await launchChrome(chrome, port);
    },
    killAll: () => {
      for (const c of all) c.proc.kill("SIGKILL");
    },
  };
}

// ------------------------------------------------------------- profile

type Node = {
  id: number;
  callFrame: { functionName: string; url: string };
  hitCount?: number;
  children?: number[];
};
type Profile = {
  nodes: Node[];
  startTime: number;
  endTime: number;
  samples?: number[];
};

/** Busy (non-idle) self-time share by origin of the code (puppeteer, undici, ours, …). */
function breakdown(p: Profile): {
  byArea: [string, number][];
  top: [string, number][];
} {
  const total =
    p.nodes.reduce(
      (n, x) =>
        n + (x.callFrame.functionName === "(idle)" ? 0 : (x.hitCount ?? 0)),
      0,
    ) || 1;
  const area = (n: Node): string => {
    const u = n.callFrame.url;
    if (!u) {
      const f = n.callFrame.functionName;
      if (f === "(idle)" || f === "(program)" || f === "(garbage collector)")
        return f;
      return "native (JSON, crypto, …)";
    }
    if (u.includes("@cloudflare/puppeteer")) return "@cloudflare/puppeteer";
    if (u.includes("undici") || u.includes("internal/deps"))
      return "WebSocket (undici; native in workerd)";
    if (u.includes("/apps/server/src/")) return "apps/server/src";
    if (u.includes("/packages/shared/")) return "@oa/shared";
    if (u.startsWith("node:")) return "node internals";
    return "other deps";
  };
  const byArea = new Map<string, number>();
  const byFn = new Map<string, number>();
  for (const n of p.nodes) {
    const h = n.hitCount ?? 0;
    if (!h) continue;
    const a = area(n);
    if (a === "(idle)") continue;
    byArea.set(a, (byArea.get(a) ?? 0) + h);
    if (a === "(idle)") continue;
    const k = `${n.callFrame.functionName || "(anon)"} ${path.basename(n.callFrame.url)}`;
    byFn.set(k, (byFn.get(k) ?? 0) + h);
  }
  const pct = (m: Map<string, number>) =>
    [...m]
      .map(([k, v]) => [k, (100 * v) / total] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  return { byArea: pct(byArea), top: pct(byFn).slice(0, 15) };
}

// ------------------------------------------------------------- run

export type ThumbBenchResult = {
  format: string;
  coldMs: number | null;
  warmMs: number[];
};

const p = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

export async function runThumbBench(
  chrome: string,
  runs = 6,
): Promise<{ results: ThumbBenchResult[]; report: string }> {
  installGlobals();
  const env = makeEnv() as ReturnType<typeof makeEnv> & { BROWSER?: Fetcher };
  (env as { ASSETS: unknown }).ASSETS = assets;
  (env as { SERVER_THUMBNAILS?: string }).SERVER_THUMBNAILS = "on";
  const userId = newId();
  await getDb(env).insert(users).values({
    id: userId,
    email: "owner@example.com",
    name: "owner",
    role: "owner",
    createdAt: Date.now(),
  });
  const owner = (await getUser(env as Env, userId)) as Member;

  // Publish, then prefetch each page from the real content app.
  const dir = mkdtempSync(path.join(tmpdir(), "oa-thumb-content-"));
  const ids: { id: string; format: string }[] = [];
  for (const a of ARTIFACTS) {
    const { id } = await publish(
      env as Env,
      owner,
      {
        title: `Bench ${a.format}`,
        format: a.format,
        content: a.content,
        ...("language" in a ? { language: a.language } : {}),
      } as never,
      null,
    );
    ids.push({ id, format: a.format });
    const { prefix } = await signContent(env as Env, id, 1);
    for (const rest of ["__view", a.entry]) {
      const { ctx, settle } = execCtx();
      const res = await worker.fetch(
        new Request(`${CONTENT}${prefix}${rest}`) as never,
        env as Env,
        ctx as never,
      );
      const body = new Uint8Array(await res.arrayBuffer());
      await settle();
      const base = path.join(dir, id, "v1", rest);
      mkdirSync(path.dirname(base), { recursive: true });
      writeFileSync(`${base}.body`, body);
      writeFileSync(
        `${base}.meta`,
        JSON.stringify({
          status: res.status,
          headers: Object.fromEntries(res.headers),
        }),
      );
    }
  }

  const server = spawn(
    process.execPath,
    [here("./bench-static.mjs"), dir, RENDER, RUNTIME],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const port = await new Promise<number>((r) =>
    createInterface({ input: server.stdout as NodeJS.ReadableStream }).once(
      "line",
      (l) => r(Number(l)),
    ),
  );
  let browser = browserBinding(chrome, port);
  env.BROWSER = browser.binding;

  let clock = Date.now();
  const capture = async (id: string) => {
    await env.DB.prepare(
      "update artifacts set has_thumbnail = 0, thumbnail_version = null where id = ?",
    )
      .bind(id)
      .run();
    await env.FILES.delete(`thumbs/${id}.webp`);
    clock += THUMB.launchGapMs;
    await browser.prepare();
    meter.reset();
    const r = await meterDo(() =>
      captureThumbnail(env as Env, id, 1, { now: clock }),
    );
    if (r !== "stored") throw new Error(`capture: ${r}`);
    return meter.durableObject / 1000;
  };

  const session = new Session();
  session.connect();
  const results: ThumbBenchResult[] = [];
  let profile: Profile | null = null;
  try {
    for (const { id, format } of ids) {
      const coldMs = results.length === 0 ? await capture(id) : null;
      const warmMs: number[] = [];
      for (let i = 0; i < runs; i++) warmMs.push(await capture(id));
      results.push({ format, coldMs, warmMs });
    }
    // One profiled warm round over every format (sampling, 100 µs).
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 100 });
    await session.post("Profiler.start");
    for (const { id } of ids) await capture(id);
    profile = ((await session.post("Profiler.stop")) as { profile: Profile })
      .profile;
  } finally {
    session.disconnect();
    browser.killAll();
  }

  // CDP traffic of one more warm markdown capture.
  const lines0: string[] = [];
  {
    const md = ids[0];
    if (md) {
      browser.killAll();
      browser = browserBinding(chrome, port);
      env.BROWSER = browser.binding;
      traffic.reset();
      try {
        await capture(md.id);
      } finally {
        browser.killAll();
      }
      const rows = [...traffic.in].sort((a, b) => b[1].bytes - a[1].bytes);
      const n = rows.reduce((x, [, v]) => x + v.n, 0);
      const bytes = rows.reduce((x, [, v]) => x + v.bytes, 0);
      lines0.push(
        "",
        `CDP traffic, one markdown capture: ${n} messages in (${(bytes / 1024).toFixed(0)} KB), ${traffic.out} out`,
        ...rows
          .slice(0, 15)
          .map(
            ([k, v]) =>
              `  ${String(v.n).padStart(4)} × ${(v.bytes / 1024).toFixed(1).padStart(7)} KB  ${k}`,
          ),
      );
    }
  }
  server.kill();
  const lines = [
    "| format | cold ms | warm p50 ms | warm p95 ms |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.format} | ${r.coldMs?.toFixed(1) ?? "-"} | ${p(r.warmMs, 0.5).toFixed(1)} | ${p(r.warmMs, 0.95).toFixed(1)} |`,
    ),
  ];
  if (profile) {
    const b = breakdown(profile);
    lines.push("", "Self time by area (profiled warm round):");
    for (const [k, v] of b.byArea)
      lines.push(`  ${v.toFixed(1).padStart(5)}%  ${k}`);
    lines.push("", "Top functions:");
    for (const [k, v] of b.top)
      lines.push(`  ${v.toFixed(1).padStart(5)}%  ${k}`);
  }
  return { results, report: [...lines, ...lines0].join("\n") };
}
