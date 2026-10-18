import {
  type AgentRef,
  isId,
  LIMITS,
  type PublishInput,
  PublishInputSchema,
  R,
} from "@oa/shared";
import type { Context } from "hono";
import { requireUser } from "../auth/authz.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { publish } from "../services/artifacts.js";
import { planFiles, RESERVED_KEYS } from "../services/manifest.js";
import type { AppType } from "./index.js";

// Base64 inflates inline bytes by 4/3; allow some JSON overhead on top.
const MAX_BODY = Math.ceil((LIMITS.inlineBytes * 4) / 3) + 256 * 1024;
const VERSIONS = "/api/v1/artifacts/:id/versions";

const tooLarge = () =>
  new ApiError("too_large", `Request body exceeds ${MAX_BODY} bytes`);

/** Reads the body with a running cap: 413 as soon as MAX_BODY is exceeded. */
async function readCapped(c: Context<AppEnv>): Promise<Uint8Array> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) throw tooLarge();
  const body = c.req.raw.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
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

/** Parses PublishInput; schema failures re-run planFiles for a precise {path, reason}. */
async function publishInput(
  c: Context<AppEnv>,
  id?: string,
): Promise<PublishInput> {
  const buf = await readCapped(c);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
  const files = (raw as { files?: unknown } | null)?.files;
  if (files && typeof files === "object")
    for (const k of RESERVED_KEYS)
      if (Object.hasOwn(files, k))
        throw new ApiError(
          "bad_request",
          `Invalid file "${k}": reserved_name`,
          {
            path: k,
            reason: "reserved_name",
          },
        );
  if (id !== undefined && raw && typeof raw === "object" && !Array.isArray(raw))
    (raw as { id?: unknown }).id = id;
  const r = PublishInputSchema.safeParse(raw);
  if (r.success) return r.data;
  if (raw && typeof raw === "object") planFiles(raw as PublishInput);
  throw new ApiError("bad_request", "Invalid request body", r.error.issues);
}

/** REST attribution: the PAT label when authenticated by token, else none. */
const agentOf = (c: Context<AppEnv>): AgentRef | null =>
  c.var.tokenId && c.var.tokenLabel
    ? { name: c.var.tokenLabel, version: null }
    : null;

const execCtx = (c: Context<AppEnv>) => {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
};

export function mountArtifacts(app: AppType): void {
  app.post(R.artifacts, async (c) => {
    const user = requireUser(c);
    const input = await publishInput(c);
    return c.json(
      await publish(c.env, user, input, agentOf(c), execCtx(c), "create"),
      201,
    );
  });

  app.post(VERSIONS, async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id");
    if (!isId(id)) throw new ApiError("not_found", "Not found");
    const input = await publishInput(c, id);
    return c.json(
      await publish(c.env, user, input, agentOf(c), execCtx(c), "version"),
      201,
    );
  });
}
