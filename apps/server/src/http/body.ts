import type { Context } from "hono";
import { ApiError } from "./errors.js";

type Parser<T> = {
  safeParse(
    x: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: unknown } };
};

/** Parse a JSON request body against a (strict) schema; 400 bad_request otherwise. */
export async function jsonBody<T>(c: Context, schema: Parser<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new ApiError("bad_request", "Invalid request body", r.error.issues);
  return r.data;
}

/** Reads the body with a running cap: 413 as soon as `max` is exceeded. */
export async function readCapped(c: Context, max: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new ApiError("too_large", `Request body exceeds ${max} bytes`);
  if (Number(c.req.header("content-length") ?? 0) > max) throw tooLarge();
  const body = c.req.raw.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

/** readCapped + JSON.parse + schema; 413 past `max`, 400 on bad JSON or schema. */
export async function cappedJson<T>(
  c: Context,
  schema: Parser<T>,
  max: number,
): Promise<T> {
  const buf = await readCapped(c, max);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new ApiError("bad_request", "Invalid request body", r.error.issues);
  return r.data;
}
