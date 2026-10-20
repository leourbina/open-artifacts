// POST /__oa/nightly CPU: one Ed25519 verify over <= 1 KB (key imported once
// per isolate). Wall-clock budgets via vitest.cpu.config.ts.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { nightlyJob } from "../src/http/nightly.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { medianMs as time } from "./cpu-time.js";
import { APP, callWorker, E } from "./mcp-helpers.js";

let keys: CryptoKeyPair;
let pub: string;
let n = 0;

beforeAll(async () => {
  vi.spyOn(nightlyJob, "run").mockResolvedValue([]);
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

const signed = async (bad = false) => {
  const raw = JSON.stringify({
    installHost: "app.localhost",
    ts: Math.floor(Date.now() / 1000),
    nonce: `cpu-nonce-${Date.now()}-${n++}`,
  });
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(raw),
    ),
  );
  if (bad) sig[0] = (sig[0] ?? 0) ^ 1;
  return new Request(`${APP}/__oa/nightly`, {
    method: "POST",
    headers: { "x-oa-nightly-sig": b64urlEncode(sig) },
    body: raw,
  });
};

describe("POST /__oa/nightly CPU (Free: 10 ms)", () => {
  it("a bad signature (no D1) is under 2 ms end to end", async () => {
    const ms = await time(async () => {
      const r = await callWorker(
        await signed(true),
        E({ NIGHTLY_PUBKEY: pub }),
      );
      await r.text();
    });
    expect(ms).toBeLessThan(2);
  });

  it("an accepted trigger (verify + nonce insert) is under 5 ms end to end", async () => {
    const ms = await time(async () => {
      const r = await callWorker(await signed(), E({ NIGHTLY_PUBKEY: pub }));
      expect(r.status).toBe(202);
    });
    expect(ms).toBeLessThan(5);
  });
});
