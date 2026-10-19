/** Placeholder in the generic token snippet; the other agents read OA_TOKEN. */
export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";
const NAME = "open-artifacts";

export type Snippet = {
  agent: string;
  variant: "oauth" | "token";
  language: "bash" | "json" | "toml";
  /** Where the config goes, shown above the code. */
  file?: string;
  code: string;
  /** One-line note for the token variant. */
  hint?: string;
};

/** POSIX shell single-quoting. */
const sh = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
/** TOML basic string: JSON escapes are valid TOML, plus DEL. */
const toml = (s: string) => JSON.stringify(s).replaceAll("\x7f", "\\u007F");
const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * MCP client snippets per agent and auth variant. Shapes match setup's
 * `agent-config` step and the connect-agents docs. Never embeds a token:
 * token variants read `OA_TOKEN` from the environment. Pure.
 */
export function snippets(mcpUrl: string): Snippet[] {
  const out: Snippet[] = [];
  for (const variant of ["oauth", "token"] as const) {
    const t = variant === "token";
    const add = (
      agent: string,
      language: Snippet["language"],
      code: string,
      file?: string,
      hint?: string,
    ) =>
      out.push({
        agent,
        variant,
        language,
        code,
        ...(file ? { file } : {}),
        ...(t && hint ? { hint } : {}),
      });
    add(
      "Claude Code",
      "bash",
      t
        ? `read -rs OA_TOKEN
claude mcp add --transport http ${NAME} ${sh(mcpUrl)} --header "Authorization: Bearer $OA_TOKEN"
unset OA_TOKEN`
        : `claude mcp add --transport http ${NAME} ${sh(mcpUrl)}`,
      undefined,
      "paste the token at the hidden prompt; Claude Code stores the expanded header in its own config",
    );
    add(
      "Codex CLI",
      "toml",
      `[mcp_servers.${NAME}]\nurl = ${toml(mcpUrl)}${t ? `\nbearer_token_env_var = "OA_TOKEN"` : ""}`,
      "~/.codex/config.toml",
      "export OA_TOKEN in the shell that starts codex",
    );
    add(
      "Cursor",
      "json",
      json({
        mcpServers: {
          [NAME]: {
            url: mcpUrl,
            ...(t
              ? { headers: { Authorization: "Bearer ${env:OA_TOKEN}" } }
              : {}),
          },
        },
      }),
      "~/.cursor/mcp.json",
      "export OA_TOKEN before launching Cursor",
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
            ...(t
              ? {
                  oauth: false,
                  headers: { Authorization: "Bearer {env:OA_TOKEN}" },
                }
              : {}),
          },
        },
      }),
      "opencode.json",
      "export OA_TOKEN before launching OpenCode; an unset OA_TOKEN becomes an empty string",
    );
    add(
      "Generic",
      "json",
      json({
        mcpServers: {
          [NAME]: {
            type: "http",
            url: mcpUrl,
            ...(t
              ? { headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } }
              : {}),
          },
        },
      }),
      undefined,
      `replace ${TOKEN_PLACEHOLDER} with your token; keep this file out of git`,
    );
  }
  return out;
}
