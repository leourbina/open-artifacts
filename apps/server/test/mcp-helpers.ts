import { env } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import worker from "../src/index.js";
import { fetchAndWait } from "./helpers.js";

export const APP = "https://app.localhost";
export const MCP_URL = `${APP}/mcp`;

export const E = (over: Record<string, unknown> = {}) =>
  ({ ...(env as object), ...over }) as never;

/**
 * RL_ANON stub: `max` per key (the binding's 30/min) with no clock, so a test
 * never straddles the real fixed window. `counts` records every key charged.
 */
export const limiter = (max = 30) => {
  const counts = new Map<string, number>();
  return {
    counts,
    RL_ANON: {
      async limit({ key }: { key: string }) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= max };
      },
    },
  };
};

/** Calls the Worker (default export), awaiting its waitUntil work. */
export const callWorker = (req: Request, e: unknown = E()) =>
  fetchAndWait(worker as never, req, e);

/** An MCP client connected to the Worker's /mcp with `Authorization: Bearer <token>`. */
export async function connect(
  token: string,
  opts: {
    env?: unknown;
    clientInfo?: { name: string; version: string };
    /** Negotiate the 2026-07-28 per-request era instead of 2025 (the default). */
    modern?: boolean;
  } = {},
): Promise<Client> {
  const client = new Client(
    opts.clientInfo ?? { name: "test-client", version: "9.9.9" },
    opts.modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) =>
      callWorker(new Request(String(url), init as RequestInit), opts.env),
  });
  await client.connect(transport);
  return client;
}

export type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

export async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as unknown as ToolResult;
}

export const textOf = (r: ToolResult) =>
  r.content.map((c) => c.text ?? "").join("\n");

/** A fresh client IP per registration, so tests never share one RL_ANON key. */
let ipSeq = 0;
export const nextIp = () => {
  ipSeq++;
  return `10.${Math.floor(Math.random() * 250)}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};
