/** Placeholder shown in token snippets until a real token is on screen. */
export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";
const NAME = "open-artifacts";

export type Snippet = {
  agent: string;
  variant: "oauth" | "token";
  language: "bash" | "json" | "toml";
  /** Where the config goes, shown above the code. */
  file?: string;
  code: string;
};

/** POSIX shell single-quoting. */
const sh = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** TOML basic string: JSON escapes are valid TOML, plus DEL. */
const toml = (s: string) => JSON.stringify(s).replaceAll("\x7f", "\\u007F");
const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * MCP client snippets per agent and auth variant. Shapes match setup's
 * `agent-config` step and the connect-agents docs. Pure.
 */
export function snippets(mcpUrl: string, token?: string): Snippet[] {
  const bearer = `Bearer ${token ?? TOKEN_PLACEHOLDER}`;
  const headers = { Authorization: bearer };
  const out: Snippet[] = [];
  for (const variant of ["oauth", "token"] as const) {
    const t = variant === "token";
    const add = (
      agent: string,
      language: Snippet["language"],
      code: string,
      file?: string,
    ) =>
      out.push({ agent, variant, language, code, ...(file ? { file } : {}) });
    add(
      "Claude Code",
      "bash",
      `claude mcp add --transport http ${NAME} ${sh(mcpUrl)}${t ? ` --header ${sh(`Authorization: ${bearer}`)}` : ""}`,
    );
    add(
      "Codex CLI",
      "toml",
      `[mcp_servers.${NAME}]\nurl = ${toml(mcpUrl)}${t ? `\nhttp_headers = { Authorization = ${toml(bearer)} }` : ""}`,
      "~/.codex/config.toml",
    );
    add(
      "Cursor",
      "json",
      json({
        mcpServers: { [NAME]: { url: mcpUrl, ...(t ? { headers } : {}) } },
      }),
      "~/.cursor/mcp.json",
    );
    add(
      "OpenCode",
      "json",
      json({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [NAME]: {
            type: "remote",
            url: mcpUrl,
            enabled: true,
            ...(t ? { headers } : {}),
          },
        },
      }),
      "opencode.json",
    );
    add(
      "Generic",
      "json",
      json({
        mcpServers: {
          [NAME]: { type: "http", url: mcpUrl, ...(t ? { headers } : {}) },
        },
      }),
    );
  }
  return out;
}
