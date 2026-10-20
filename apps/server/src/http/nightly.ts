import type { Context } from "hono";
import { runNightly } from "../cron.js";
import { b64urlDecode } from "../util/crypto.js";
import { utf8Decoder } from "../util/text.js";
import { readCapped } from "./body.js";
import { ApiError, toErrorResponse } from "./errors.js";
import type { AppEnv } from "./middleware.js";

/**
 * POST /__oa/nightly: hosted installs have no cron trigger of their own; a
 * central scheduler calls this instead. The body
 * `{ installHost, ts, nonce }` is signed (Ed25519, X-OA-Nightly-Sig, base64url)
 * with the key whose public half is NIGHTLY_PUBKEY. Unset key: the route does
 * not exist. Every rejection is the app's plain unknown-route 404, and nothing
 * here is logged (body, signature and nonce stay out of Workers Logs).
 */
export const NIGHTLY_PATH = "/__oa/nightly";

const MAX_BODY = 1024;
const SKEW_S = 300;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/; // 64 bytes, unpadded

const notFound = () => toErrorResponse(new ApiError("not_found", "Not found"));

/** The job, behind a seam the tests spy on. */
export const nightlyJob = { run: runNightly };

let cached: { pub: string; key: Promise<CryptoKey> } | undefined;
function verifyKey(pub: string): Promise<CryptoKey> {
  if (cached?.pub !== pub) {
    const raw = b64urlDecode(pub);
    if (raw?.byteLength !== 32) throw new Error("bad key");
    const key = crypto.subtle.importKey(
      "raw",
      raw,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    cached = { pub, key };
  }
  return cached.key;
}

/** True when the request is a fresh, correctly signed trigger for this host. */
async function accept(c: Context<AppEnv>, pub: string): Promise<boolean> {
  const sig = c.req.header("x-oa-nightly-sig") ?? "";
  if (!SIG.test(sig)) return false;
  const sigBytes = b64urlDecode(sig);
  if (!sigBytes) return false;
  const raw = await readCapped(c, MAX_BODY);
  const ok = await crypto.subtle.verify(
    "Ed25519",
    await verifyKey(pub),
    sigBytes,
    raw as Uint8Array<ArrayBuffer>,
  );
  if (!ok) return false;
  const b = JSON.parse(utf8Decoder.decode(raw)) as Record<string, unknown>;
  const { installHost, ts, nonce } = b ?? {};
  if (installHost !== c.env.APP_HOST) return false;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > SKEW_S) return false;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return false;
  // Keyed by the signed ts's day, so a replay always hits the same row.
  const day = new Date(ts * 1000).toISOString().slice(0, 10);
  const won = await c.env.DB.prepare(
    "INSERT INTO nightly_runs (day, nonce) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING nonce",
  )
    .bind(day, nonce)
    .first();
  return won !== null;
}

export async function nightly(c: Context<AppEnv>): Promise<Response> {
  const pub = c.env.NIGHTLY_PUBKEY;
  if (!pub || c.req.method !== "POST") return notFound();
  let ok = false;
  try {
    ok = await accept(c, pub);
  } catch {
    // Malformed key, body or JSON, or D1: the same 404, never logged.
  }
  if (!ok) return notFound();
  c.executionCtx.waitUntil(nightlyJob.run(c.env, c.executionCtx));
  return c.body(null, 202);
}
