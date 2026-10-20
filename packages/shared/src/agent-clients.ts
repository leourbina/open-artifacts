// MCP client setup per agent and auth variant: one source for the dashboard's
// Settings → Agents tabs and the generated skill. Pure, dependency-free.

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
  /** How to check it is connected (its tools/list). */
  verify?: string;
  /** How to make the agent pick up a config change. */
  reload?: string;
};

export type AgentClientOpts = {
  /**
   * Token variants read the PAT from this file (e.g.
   * `~/.open-artifacts/<host slug>-pat-token`) instead of the OA_TOKEN env
   * var, in the command or config, never inlined.
   */
  tokenFile?: string;
};

/** POSIX shell single-quoting. */
const sh = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
/** TOML basic string: JSON escapes are valid TOML, plus DEL. */
const toml = (s: string) => JSON.stringify(s).replaceAll("\x7f", "\\u007F");
const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * MCP client snippets per agent and auth variant, oauth first, agents in a
 * fixed order. Shapes match setup's `agent-config` step and the
 * connect-agents docs. Never embeds a token: token variants read `OA_TOKEN`
 * from the environment, or `opts.tokenFile`. Pure.
 */
export function agentClients(
  mcpUrl: string,
  opts: AgentClientOpts = {},
): Snippet[] {
  const f = opts.tokenFile;
  /** Sets OA_TOKEN from the file for one command. */
  const withEnv = (cmd: string) => `OA_TOKEN="$(cat ${f})" ${cmd}`;
  const out: Snippet[] = [];
  for (const variant of ["oauth", "token"] as const) {
    const t = variant === "token";
    const add = (
      s: Omit<Snippet, "variant" | "hint" | "file"> & {
        file?: string;
        hint?: string;
      },
    ) =>
      out.push({
        agent: s.agent,
        variant,
        language: s.language,
        code: s.code,
        ...(s.file ? { file: s.file } : {}),
        ...(t && s.hint ? { hint: s.hint } : {}),
        ...(s.verify ? { verify: s.verify } : {}),
        ...(s.reload ? { reload: s.reload } : {}),
      });
    add({
      agent: "Claude Code",
      language: "bash",
      code: !t
        ? `claude mcp add --transport http ${NAME} ${sh(mcpUrl)}`
        : f
          ? `claude mcp add --transport http ${NAME} ${sh(mcpUrl)} --header "Authorization: Bearer $(cat ${f})"`
          : `read -rs OA_TOKEN
claude mcp add --transport http ${NAME} ${sh(mcpUrl)} --header "Authorization: Bearer $OA_TOKEN"
unset OA_TOKEN`,
      hint: f
        ? `reads the token from ${f}; Claude Code stores the expanded header in its own config`
        : "paste the token at the hidden prompt; Claude Code stores the expanded header in its own config",
      verify: t
        ? `\`claude mcp list\` shows ${NAME} as connected; in a session, \`/mcp\` lists its tools.`
        : `In a session, run \`/mcp\`, pick ${NAME} and sign in in the browser; it then lists its tools.`,
      reload: "Start a new Claude Code session, or reconnect from `/mcp`.",
    });
    add({
      agent: "Codex CLI",
      language: "toml",
      code: `[mcp_servers.${NAME}]\nurl = ${toml(mcpUrl)}${t ? `\nbearer_token_env_var = "OA_TOKEN"` : ""}`,
      file: "~/.codex/config.toml",
      hint: f
        ? `start codex with the token in OA_TOKEN: ${withEnv("codex")}`
        : "export OA_TOKEN in the shell that starts codex",
      verify: t
        ? `\`codex mcp list\` shows ${NAME}.`
        : `\`codex mcp login ${NAME}\` signs in in the browser; \`codex mcp list\` then shows it.`,
      reload: "Restart codex; it reads config.toml at start.",
    });
    add({
      agent: "Cursor",
      language: "json",
      code: json({
        mcpServers: {
          [NAME]: {
            url: mcpUrl,
            ...(t
              ? { headers: { Authorization: "Bearer ${env:OA_TOKEN}" } }
              : {}),
          },
        },
      }),
      file: "~/.cursor/mcp.json",
      hint: f
        ? `launch Cursor from a shell with the token in OA_TOKEN: ${withEnv("cursor")}`
        : "export OA_TOKEN before launching Cursor",
      verify: t
        ? `Cursor Settings → MCP shows ${NAME} enabled with its tools.`
        : `Cursor Settings → MCP shows ${NAME}; sign in from there, then it lists its tools.`,
      reload:
        "Turn the server off and on in Cursor Settings → MCP, or restart Cursor.",
    });
    add({
      agent: "OpenCode",
      language: "json",
      code: json({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [NAME]: {
            type: "remote",
            url: mcpUrl,
            enabled: true,
            ...(t
              ? {
                  oauth: false,
                  headers: {
                    Authorization: f
                      ? `Bearer {file:${f}}`
                      : "Bearer {env:OA_TOKEN}",
                  },
                }
              : {}),
          },
        },
      }),
      file: "opencode.json",
      hint: f
        ? `OpenCode reads the token from ${f} itself`
        : "export OA_TOKEN before launching OpenCode; an unset OA_TOKEN becomes an empty string",
      verify: t
        ? `\`opencode mcp list\` shows ${NAME} as connected.`
        : `\`opencode mcp auth ${NAME}\` signs in in the browser; \`opencode mcp list\` then shows it.`,
      reload: "Restart opencode; it reads its config at start.",
    });
    add({
      agent: "Generic",
      language: "json",
      code: json({
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
      hint: f
        ? `have the client read ${TOKEN_PLACEHOLDER} from ${f} (its env-var or file substitution); never paste the value into a file`
        : `replace ${TOKEN_PLACEHOLDER} with your token; keep this file out of git`,
      verify:
        "Ask the client to list the server's tools (tools/list): 17, including publish_artifact.",
      reload: "Restart the client or reload its MCP servers.",
    });
  }
  return out;
}
