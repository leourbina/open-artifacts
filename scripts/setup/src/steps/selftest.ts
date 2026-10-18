import { join } from "node:path";
import type { Ctx, Step } from "../step.ts";

const TITLE = "Welcome to Open Artifacts";
const WELCOME = "scripts/setup/welcome.md";
/** Backoff in seconds between attempts: ~60s in all, for DNS/cert/deploy propagation. */
const DELAYS = [1, 2, 4, 8, 15, 15, 15];

/** Fetches until 200, retrying failures with bounded backoff. */
async function until200(
  ctx: Ctx,
  label: string,
  url: string,
  init?: RequestInit,
) {
  const sleep =
    ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    let last: string;
    try {
      const res = await ctx.deps.fetch(url, init);
      if (res.status === 200) return res;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    const delay = DELAYS[i];
    if (delay === undefined)
      throw new Error(`${label}: ${url} not 200 after ~60s (last: ${last})`);
    await sleep(delay * 1000);
  }
}

/** A JSON-RPC body, plain JSON or the matching SSE `data:` event. */
async function rpcResult(res: Response, id: number, method: string) {
  const text = await res.text();
  const msgs = res.headers.get("content-type")?.includes("event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const msg = msgs.find((m) => m.id === id);
  if (!msg || msg.error)
    throw new Error(`MCP ${method}: ${msg?.error?.message ?? "no response"}`);
  return msg.result;
}

/** tools/list, then publish (or update) the welcome page; returns its id. */
async function mcp(ctx: Ctx, token: string, prev?: string): Promise<string> {
  const url = `https://${ctx.opts.appHost}/mcp`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  let id = 0;
  const post = async (method: string, params: unknown, retry = false) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    const init = { method: "POST", headers, body };
    const res = retry
      ? await until200(ctx, `MCP ${method}`, url, init)
      : await ctx.deps.fetch(url, init);
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status}`);
    return rpcResult(res, id, method);
  };
  await post(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "oa-setup", version: "1" },
    },
    true,
  );
  await ctx.deps.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  const { tools } = await post("tools/list", {});
  if (!tools?.some((t: { name: string }) => t.name === "publish_artifact"))
    throw new Error("MCP tools/list has no publish_artifact");
  const content = ctx.fs.read(join(ctx.root, WELCOME));
  if (content === null) throw new Error(`missing ${WELCOME}`);
  const publish = (id?: string) =>
    post("tools/call", {
      name: "publish_artifact",
      arguments: {
        ...(id ? { id } : {}),
        title: TITLE,
        format: "markdown",
        content,
      },
    });
  const text = (r: { content?: { text?: string }[] }) =>
    r?.content?.[0]?.text ?? "no id";
  let r = await publish(prev);
  // The saved welcome artifact was deleted: publish a fresh one instead.
  if (prev && r?.isError && /^not_found\b/.test(text(r))) {
    ctx.notes.push(`welcome artifact ${prev} was deleted; published a new one`);
    r = await publish();
  }
  const out = r?.structuredContent?.id;
  if (r?.isError || typeof out !== "string")
    throw new Error(`MCP publish_artifact: ${text(r)}`);
  return out;
}

/** The private artifact's signed content URL must serve the welcome text. */
async function content(ctx: Ctx, token: string, id: string): Promise<string> {
  const api = `https://${ctx.opts.appHost}/api/v1/artifacts/${encodeURIComponent(id)}/content-url`;
  const res = await until200(ctx, "content-url", api, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { url } = (await res.json()) as { url?: string };
  if (typeof url !== "string") throw new Error("content-url: no url");
  const body = await (await until200(ctx, "welcome content", url)).text();
  if (!body.includes(TITLE))
    throw new Error(`welcome content at ${url} lacks "${TITLE}"`);
  return url;
}

export const selftest: Step = {
  name: "selftest",
  check: async () => "todo",
  async apply(state, ctx) {
    const app = `https://${ctx.opts.appHost}`;
    await until200(ctx, "healthz", `${app}/healthz`);
    const oidc = `https://${state.teamDomain}/cdn-cgi/access/sso/oidc/${state.accessClientId}/.well-known/openid-configuration`;
    await until200(ctx, "OIDC discovery", oidc);
    if (!ctx.pat) {
      ctx.notes.push(
        "healthz and OIDC discovery ok; MCP check skipped: no token minted this run (rerun with --new-owner-token to test it)",
      );
      ctx.data = { mcp: "skipped" };
      return undefined;
    }
    const artifactId = await mcp(ctx, ctx.pat, state.welcomeArtifactId);
    state.welcomeArtifactId = artifactId;
    const contentUrl = await content(ctx, ctx.pat, artifactId);
    ctx.notes.push(`healthz, OIDC discovery, MCP publish, content ok`);
    ctx.data = { mcp: "ok", artifactId, contentUrl };
    return undefined;
  },
};
