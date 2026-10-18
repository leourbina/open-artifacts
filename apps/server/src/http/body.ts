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
