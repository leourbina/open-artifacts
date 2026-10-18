import type { Step } from "../step.ts";

const PLACEHOLDER = "<YOUR_TOKEN>";

/** MCP client snippets for a streamable-HTTP server with a bearer header. */
export function snippets(name: string, url: string, token: string) {
  const auth = `Bearer ${token}`;
  const headers = { Authorization: auth };
  const pretty = (v: unknown) => JSON.stringify(v, null, 2);
  return {
    claudeCode: `claude mcp add --transport http ${name} ${url} --header "Authorization: ${auth}"`,
    codex: `# ~/.codex/config.toml\n[mcp_servers.${name}]\nurl = "${url}"\nhttp_headers = { Authorization = "${auth}" }`,
    cursor: `// .cursor/mcp.json\n${pretty({ mcpServers: { [name]: { url, headers } } })}`,
    opencode: `// opencode.json\n${pretty({
      $schema: "https://opencode.ai/config.json",
      mcp: { [name]: { type: "remote", url, enabled: true, headers } },
    })}`,
    json: pretty({ mcpServers: { [name]: { type: "http", url, headers } } }),
  };
}

const TITLES = {
  claudeCode: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  json: "Generic JSON",
};

export const agentConfig: Step = {
  name: "agent-config",
  async check(_state, ctx) {
    if (ctx.pat) return "todo";
    if (ctx.opts.upgrade) {
      ctx.notes.push(
        "skipped (--upgrade); pass --new-owner-token for snippets",
      );
      return "done";
    }
    ctx.notes.push(`no token minted this run; snippets use ${PLACEHOLDER}`);
    await agentConfig.apply(_state, ctx);
    return "done";
  },
  async apply(_state, ctx) {
    const url = `https://${ctx.opts.appHost}/mcp`;
    const s = snippets(ctx.opts.name, url, ctx.pat ?? PLACEHOLDER);
    const welcomeUrl = ctx.welcomeUrl;
    ctx.data = { url, snippets: s, ...(welcomeUrl ? { welcomeUrl } : {}) };
    const welcome = welcomeUrl ? `\n  Welcome artifact: ${welcomeUrl}\n` : "";
    ctx.human =
      welcome +
      Object.entries(s)
        .map(
          ([k, v]) =>
            `\n  ${TITLES[k as keyof typeof s]}:\n${v.replace(/^/gm, "    ")}`,
        )
        .join("\n");
    return undefined;
  },
};
