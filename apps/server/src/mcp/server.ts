import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  type AgentRef,
  LIMITS,
  MCP_PATH,
  type Member,
  QUOTA_MESSAGE,
} from "@oa/shared";
import { createMcpHandler } from "agents/mcp/server";
import type { Caller } from "../auth/authz.js";
import type { Env } from "../env.js";
import {
  ApiError,
  appOrigin,
  errorJson,
  isD1QuotaError,
} from "../http/errors.js";
import { toRuntimeApiError } from "../runtime/do.js";
import { INSTRUCTIONS, RUNTIME_DOC_URI } from "./instructions.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerDataTools } from "./tools/data.js";

export type McpContext = {
  env: Env;
  user: Member;
  /** PAT: { label, null }. OAuth: { clientName, null } plus `clientVersion`. */
  agent: AgentRef | null;
  /** For waitUntil work (search indexing after publish). */
  exec?: Pick<ExecutionContext, "waitUntil">;
  /** Fill agent.version from the MCP clientInfo.version (OAuth clients). */
  clientVersion?: boolean;
};

/** What the tool modules get: the context plus the per-call agent ref. */
export type ToolEnv = McpContext & {
  caller: Caller;
  agentNow: () => AgentRef | null;
};

/** `{ content: [one-line summary], structuredContent }`. */
export function ok(
  text: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: text.replace(/\s*\n\s*/g, " ") }],
    structuredContent,
  };
}

/** ApiError (and DO runtime errors) → `"<code>: <message>"`; D1 quota → QUOTA_MESSAGE. */
export function errorResult(e: unknown): CallToolResult {
  const text = (code: string, message: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
  });
  const api = e instanceof ApiError ? e : toRuntimeApiError(e);
  if (api) {
    if (api.code === "quota_exceeded")
      return text("quota_exceeded", QUOTA_MESSAGE);
    return text(api.code, api.message);
  }
  if (isD1QuotaError(e)) return text("quota_exceeded", QUOTA_MESSAGE);
  console.error(e);
  return text("internal", "Internal error");
}

/** Runs a tool body, mapping thrown errors to an isError result. */
export async function guard(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return errorResult(e);
  }
}

export function createServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "open-artifacts", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );
  const agentNow = (): AgentRef | null => {
    if (!ctx.agent || !ctx.clientVersion) return ctx.agent;
    const v = server.server.getClientVersion()?.version;
    return {
      name: ctx.agent.name,
      version: typeof v === "string" && v ? v.slice(0, 100) : null,
    };
  };
  const t: ToolEnv = {
    ...ctx,
    caller: { kind: "user", user: ctx.user },
    agentNow,
  };
  registerArtifactTools(server, t);
  registerDataTools(server, t);
  server.registerResource(
    "runtime-docs",
    RUNTIME_DOC_URI,
    {
      title: "Open Artifacts guide",
      description:
        "Formats, multi-file publishing, large uploads, capabilities and the window.openArtifacts API.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: INSTRUCTIONS },
      ],
    }),
  );
  return server;
}

/**
 * The largest tool argument (base64 inline publish at 4/3, or an
 * artifact_data_set document) plus JSON-RPC overhead. Oversize inline content
 * under it reaches publish_artifact, which answers too_large with the
 * create_upload hint.
 */
export const MAX_MCP_BODY =
  Math.max(Math.ceil((LIMITS.inlineBytes * 4) / 3), LIMITS.docBytes) +
  256 * 1024;

const tooLarge = () =>
  errorJson(413, "too_large", `Request body exceeds ${MAX_MCP_BODY} bytes`);

/**
 * Reads an MCP request body once, into one buffer, with a running cap: 413 on a
 * declared or streamed size over MAX_MCP_BODY. Returns a new Request carrying the
 * buffer, so every era (including the 2025 fallback, which reads the body
 * itself) sees a bounded body and nothing reads the stream twice.
 */
export async function capMcpBody(req: Request): Promise<Request | Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_MCP_BODY)
    return tooLarge();
  if (!req.body) return req;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MCP_BODY) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const headers = new Headers(req.headers);
  headers.set("content-length", String(size));
  return new Request(req.url, { method: req.method, headers, body: buf });
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/**
 * The canonical MCP resource URL (OAuth audience). https, except plain http on a
 * loopback host in dev (OAuth allows http only there).
 */
export function mcpResource(
  env: Pick<Env, "APP_HOST" | "ENVIRONMENT">,
): string {
  const origin =
    env.ENVIRONMENT === "dev" && !LOOPBACK.test(env.APP_HOST)
      ? `https://${env.APP_HOST}`
      : appOrigin(env);
  return `${origin}${MCP_PATH}`;
}

/** RFC 9728 metadata URL for the resource. */
export function mcpResourceMetadataUrl(
  env: Pick<Env, "APP_HOST" | "ENVIRONMENT">,
): string {
  const u = new URL(mcpResource(env));
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
}

/** 401 for a bad bearer token at /mcp, pointing at the resource metadata. */
export function mcpUnauthorized(
  env: Pick<Env, "APP_HOST" | "ENVIRONMENT">,
  message = "Invalid or revoked token",
): Response {
  return errorJson(401, "unauthorized", message, undefined, {
    "WWW-Authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${mcpResourceMetadataUrl(env)}"`,
  });
}

/**
 * Stateless Streamable HTTP handler: a fresh server per request. No CORS (MCP
 * clients aren't browsers); a browser Origin must be the app host.
 */
export function mcpHandler(env: Env, factory: () => McpServer) {
  return createMcpHandler(factory, {
    route: MCP_PATH,
    corsOptions: false,
    allowedOriginHostnames: [new URL(`http://${env.APP_HOST}`).hostname],
    maxRequestBodySize: MAX_MCP_BODY,
  });
}
