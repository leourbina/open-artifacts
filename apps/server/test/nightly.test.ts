import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runNightly, sweepNightlyRuns } from "../src/cron.js";
import { nightlyJob } from "../src/http/nightly.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { APP, callWorker, E } from "./mcp-helpers.js";

const URL_ = `${APP}/__oa/nightly`;
const HOST = "app.localhost";
let keys: CryptoKeyPair;
let pub: string;
let n = 0;
const nonce = () => `nonce${Date.now().toString(36)}x${n++}`.padEnd(16, "a");

const sign = async (raw: string, k = keys.privateKey) =>
  b64urlEncode(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", k, new TextEncoder().encode(raw)),
    ),
  );

type Body = { installHost?: unknown; ts?: unknown; nonce?: unknown };
const body = (o: Body = {}) =>
  JSON.stringify({
    installHost: HOST,
    ts: Math.floor(Date.now() / 1000),
    nonce: nonce(),
    ...o,
  });

const post = async (
  raw: string,
  opts: { sig?: string; url?: string; env?: Record<string, unknown> } = {},
) =>
  callWorker(
    new Request(opts.url ?? URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-nightly-sig": opts.sig ?? (await sign(raw)),
      },
      body: raw,
    }),
    E({ NIGHTLY_PUBKEY: pub, ...opts.env }),
  );

const snap = async (r: Response) => ({
  status: r.status,
  headers: [...r.headers.entries()],
  body: await r.text(),
});

// An unknown route's 404, the reference every failure must match.
const unknown = async (method = "POST") =>
  snap(
    await callWorker(
      new Request(`${APP}/__oa/nope`, {
        method,
        ...(method === "POST" ? { body: "x" } : {}),
      }),
      E({ NIGHTLY_PUBKEY: pub }),
    ),
  );

// Forget today's run marker, so the next valid trigger runs the job.
const freshDay = () =>
  env.DB.prepare("delete from nightly_runs where nonce = 'run'").run();

const keyPair = async () =>
  (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
const rawPub = async (k: CryptoKeyPair) =>
  b64urlEncode(
    new Uint8Array(
      (await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer,
    ),
  );

const real = nightlyJob.run;
const run = vi.spyOn(nightlyJob, "run").mockResolvedValue([]);

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  pub = b64urlEncode(
    new Uint8Array(
      (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
    ),
  );
});

describe("POST /__oa/nightly", () => {
  it("the seam is runNightly, the same job scheduled() runs", () => {
    expect(real).toBe(runNightly);
  });

  it("a valid signature returns 202 with an empty body and runs the job", async () => {
    await freshDay();
    run.mockClear();
    const r = await post(body());
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
    expect(run).toHaveBeenCalledTimes(1);
  });

  const fails: [string, () => Promise<Response>][] = [
    [
      "unset NIGHTLY_PUBKEY",
      () => post(body(), { env: { NIGHTLY_PUBKEY: undefined } }),
    ],
    [
      "empty NIGHTLY_PUBKEY",
      () => post(body(), { env: { NIGHTLY_PUBKEY: "" } }),
    ],
    [
      "a bad signature",
      async () => {
        const raw = body();
        const sig = await sign(`${raw} `);
        return post(raw, { sig });
      },
    ],
    ["a missing signature", () => post(body(), { sig: "" })],
    [
      "another key's signature",
      async () => {
        const other = (await crypto.subtle.generateKey(
          { name: "Ed25519" },
          true,
          ["sign", "verify"],
        )) as CryptoKeyPair;
        const raw = body();
        return post(raw, { sig: await sign(raw, other.privateKey) });
      },
    ],
    [
      "host A's signed body at host B",
      () => post(body({ installHost: "other.example.com" })),
    ],
    [
      "ts 6 minutes old",
      () => post(body({ ts: Math.floor(Date.now() / 1000) - 360 })),
    ],
    [
      "ts 6 minutes ahead",
      () => post(body({ ts: Math.floor(Date.now() / 1000) + 360 })),
    ],
    ["a non-numeric ts", () => post(body({ ts: "1" }))],
    ["a short nonce", () => post(body({ nonce: "abc" }))],
    [
      "a non-base64url nonce",
      () => post(body({ nonce: `${"a".repeat(15)}!` })),
    ],
    ["a 65-char nonce", () => post(body({ nonce: "a".repeat(65) }))],
    ["a signed non-JSON body", () => post("not json")],
    ["an oversize body", () => post(body({ pad: "x".repeat(1100) } as Body))],
  ];

  for (const [name, f] of fails)
    it(`${name} returns the unknown-route 404 and does not run the job`, async () => {
      run.mockClear();
      expect(await snap(await f())).toEqual(await unknown());
      expect(run).not.toHaveBeenCalled();
    });

  it("an oversize body with no Content-Length returns the 404", async () => {
    run.mockClear();
    const raw = body({ pad: "x".repeat(1100) } as Body);
    const bytes = new TextEncoder().encode(raw);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const r = await callWorker(
      new Request(URL_, {
        method: "POST",
        headers: { "x-oa-nightly-sig": await sign(raw) },
        body: stream,
        duplex: "half",
      } as RequestInit),
      E({ NIGHTLY_PUBKEY: pub }),
    );
    expect(await snap(r)).toEqual(await unknown());
    expect(run).not.toHaveBeenCalled();
  });

  it("the content host returns its own unknown-route 404", async () => {
    run.mockClear();
    const r = await post(body(), {
      url: "https://content.localhost/__oa/nightly",
    });
    const ref = await callWorker(
      new Request("https://content.localhost/__oa/nope", {
        method: "POST",
        body: "x",
      }),
      E({ NIGHTLY_PUBKEY: pub }),
    );
    expect(r.status).toBe(404);
    expect(await snap(r)).toEqual(await snap(ref));
    expect(run).not.toHaveBeenCalled();
  });

  it("GET and PUT return the unknown-route 404", async () => {
    for (const method of ["GET", "PUT"]) {
      const r = await callWorker(
        new Request(URL_, { method }),
        E({ NIGHTLY_PUBKEY: pub }),
      );
      expect(await snap(r)).toEqual(await unknown(method));
    }
  });

  it("a reused nonce returns 404", async () => {
    const raw = body();
    const sig = await sign(raw);
    expect((await post(raw, { sig })).status).toBe(202);
    run.mockClear();
    expect(await snap(await post(raw, { sig }))).toEqual(await unknown());
    expect(run).not.toHaveBeenCalled();
  });

  it("two concurrent requests with the same nonce: exactly one 202", async () => {
    const raw = body();
    const sig = await sign(raw);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => post(raw, { sig })),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([202, 404, 404, 404, 404]);
  });

  it("logs nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (k) => vi.spyOn(console, k).mockImplementation(() => {}),
    );
    try {
      await post(body());
      for (const [, f] of fails) await f();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("POST /__oa/nightly: once per day", () => {
  it("two valid nonces on the same day both get 202; the job runs once", async () => {
    await freshDay();
    run.mockClear();
    expect((await post(body())).status).toBe(202);
    expect((await post(body())).status).toBe(202);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("concurrent valid nonces on a fresh day run the job once", async () => {
    await freshDay();
    run.mockClear();
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(body())));
    expect(rs.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("POST /__oa/nightly: NIGHTLY_PUBKEY", () => {
  for (const [name, key] of [
    ["31 bytes", () => b64urlEncode(new Uint8Array(31).fill(7))],
    ["33 bytes", () => b64urlEncode(new Uint8Array(33).fill(7))],
    ["not base64url", () => `${pub.slice(0, -1)}!`],
    ["padded base64", () => `${pub}=`],
  ] as const)
    it(`a key of ${name} gives the 404 (never 500) on every request`, async () => {
      run.mockClear();
      for (let i = 0; i < 3; i++) {
        const r = await post(body(), { env: { NIGHTLY_PUBKEY: key() } });
        expect(await snap(r)).toEqual(await unknown());
      }
      expect(run).not.toHaveBeenCalled();
    });

  it("a rotated key is re-imported: the new key verifies, the old one does not", async () => {
    const next = await keyPair();
    const nextPub = await rawPub(next);
    expect((await post(body())).status).toBe(202); // caches the old key
    const raw = body();
    const sigNew = await sign(raw, next.privateKey);
    expect(
      (await post(raw, { sig: sigNew, env: { NIGHTLY_PUBKEY: nextPub } }))
        .status,
    ).toBe(202);
    expect(
      (await post(body(), { env: { NIGHTLY_PUBKEY: nextPub } })).status,
    ).toBe(404);
    // And back again.
    expect((await post(body())).status).toBe(202);
  });
});

describe("POST /__oa/nightly: rejections are byte-identical to POST /__oa/nope", () => {
  const bytes = async (r: Response) => ({
    status: r.status,
    statusText: r.statusText,
    headers: [...r.headers.entries()],
    body: [...new Uint8Array(await r.arrayBuffer())],
  });
  // The same request (headers, body) at an unknown path on the same host.
  const pair = async (
    raw: string,
    opts: { sig?: string; host?: string; env?: Record<string, unknown> } = {},
  ) => {
    const sig = opts.sig ?? (await sign(raw));
    const host = opts.host ?? APP;
    const req = (path: string) =>
      new Request(`${host}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oa-nightly-sig": sig,
        },
        body: raw,
      });
    const e = E({ NIGHTLY_PUBKEY: pub, ...opts.env });
    return [
      await bytes(await callWorker(req("/__oa/nightly"), e)),
      await bytes(await callWorker(req("/__oa/nope"), e)),
    ];
  };
  const now = () => Math.floor(Date.now() / 1000);
  const cases: [string, () => Promise<unknown[]>][] = [
    [
      "bad sig",
      async () => {
        const raw = body();
        return pair(raw, { sig: await sign(`${raw}x`) });
      },
    ],
    ["stale ts", () => pair(body({ ts: now() - 360 }))],
    ["future ts", () => pair(body({ ts: now() + 360 }))],
    [
      "used nonce",
      async () => {
        const raw = body();
        expect((await post(raw)).status).toBe(202);
        return pair(raw);
      },
    ],
    [
      "unset NIGHTLY_PUBKEY",
      () => pair(body(), { env: { NIGHTLY_PUBKEY: undefined } }),
    ],
    ["wrong host", () => pair(body({ installHost: "other.example.com" }))],
    ["oversize", () => pair(body({ pad: "x".repeat(1100) } as Body))],
    ["content host", () => pair(body(), { host: "https://content.localhost" })],
  ];
  for (const [name, f] of cases)
    it(name, async () => {
      run.mockClear();
      const [got, ref] = await f();
      expect((got as { status: number }).status).toBe(404);
      expect(got).toEqual(ref);
      expect(run).not.toHaveBeenCalled();
    });
});

describe("sweepNightlyRuns", () => {
  it("drops rows older than 2 days and keeps recent ones", async () => {
    const DAY = 86400_000;
    const now = Date.UTC(2030, 0, 10, 12);
    const day = (d: number) =>
      new Date(now - d * DAY).toISOString().slice(0, 10);
    for (const d of [0, 1, 2, 3, 5])
      await env.DB.prepare(
        "insert into nightly_runs (day, nonce) values (?, ?)",
      )
        .bind(day(d), "sweep-test-nonce")
        .run();
    await sweepNightlyRuns(env, now);
    const { results } = await env.DB.prepare(
      "select day from nightly_runs where nonce = 'sweep-test-nonce' order by day",
    ).all<{ day: string }>();
    expect(results.map((r) => r.day)).toEqual([day(2), day(1), day(0)]);
  });
});
