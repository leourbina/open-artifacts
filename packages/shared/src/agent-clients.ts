// MCP client setup per agent and auth variant: one source for the dashboard's
// Settings → Agents tabs and the generated skill. Pure, dependency-free.

/** Placeholder in the generic token snippet. */
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
  /** How to check it is connected (its tools/list). Never prints a token. */
  verify?: string;
  /** How to make the agent pick up a config change. */
  reload?: string;
};

export type AgentClientOpts = {
  /**
   * The PAT file (e.g. `~/.open-artifacts/<host slug>-pat-token`). With it,
   * each client gets one token mechanism that reads the file at connect
   * time: no env vars, nothing inlined, nothing printed. Cursor has none
   * (OAuth only). Without it: the dashboard's OA_TOKEN env-var snippets.
   */
  tokenFile?: string;
};

/** POSIX shell single-quoting. */
const sh = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
/** TOML basic string: JSON escapes are valid TOML, plus DEL. */
const toml = (s: string) => JSON.stringify(s).replaceAll("\x7f", "\\u007F");
const json = (v: unknown) => JSON.stringify(v, null, 2);

const CURSOR_VERIFY_OAUTH = `Find ${NAME} under Customize (sidebar); when Cursor asks you to sign in, finish it in the browser, and it then lists its tools.`;
const CURSOR_RELOAD =
  "Toggle the server off and on in Customize, or restart Cursor.";
const GENERIC_VERIFY =
  "Ask the client to list the server's tools (tools/list); publish_artifact is among them.";
const GENERIC_RELOAD = "Restart the client or reload its MCP servers.";

/**
 * MCP client snippets per agent and auth variant: every oauth variant first,
 * then the token variants, agents in a fixed order (Claude Code, Codex CLI,
 * Cursor, OpenCode, Generic). Never embeds a token. Pure.
 */
export function agentClients(
  mcpUrl: string,
  opts: AgentClientOpts = {},
): Snippet[] {
  return opts.tokenFile
    ? fileClients(mcpUrl, opts.tokenFile)
    : envClients(mcpUrl);
}

/** The skill's form: OAuth first; tokens read the file at connect time. */
function fileClients(url: string, f: string): Snippet[] {
  /** A shell command that prints the auth header JSON from the file. */
  const helper = `printf '{"Authorization":"Bearer %s"}' "$(cat ${f})"`;
  const oauth: Snippet[] = [
    {
      agent: "Claude Code",
      variant: "oauth",
      language: "bash",
      code: `claude mcp add --transport http -s user ${NAME} ${sh(url)}`,
      verify: `In a session, run \`/mcp\` (or \`claude mcp login ${NAME}\`) and sign in through the browser; \`claude mcp list\` then shows ${NAME} as connected.`,
      reload: "Start a new Claude Code session, or reconnect from `/mcp`.",
    },
    {
      agent: "Codex CLI",
      variant: "oauth",
      language: "bash",
      code: `codex mcp add ${NAME} --url ${sh(url)}`,
      verify: `\`codex mcp login ${NAME}\` signs in through the browser; \`codex mcp list\` then shows it.`,
      reload:
        "Restart codex (CLI, IDE extension or app); it reads its config at start.",
    },
    {
      agent: "Cursor",
      variant: "oauth",
      language: "json",
      file: "~/.cursor/mcp.json",
      code: json({ mcpServers: { [NAME]: { url } } }),
      verify: CURSOR_VERIFY_OAUTH,
      reload: CURSOR_RELOAD,
    },
    {
      agent: "OpenCode",
      variant: "oauth",
      language: "json",
      file: "opencode.json",
      code: json({ mcp: { [NAME]: { type: "remote", url } } }),
      verify: `\`opencode mcp auth ${NAME}\` signs in through the browser; \`opencode mcp list\` then shows it.`,
      reload: "Restart opencode; it reads its config at start.",
    },
    {
      agent: "Generic",
      variant: "oauth",
      language: "json",
      code: json({ mcpServers: { [NAME]: { type: "http", url } } }),
      verify: GENERIC_VERIFY,
      reload: GENERIC_RELOAD,
    },
  ];
  const token: Snippet[] = [
    {
      agent: "Claude Code",
      variant: "token",
      language: "bash",
      code: `claude mcp add-json -s user ${NAME} ${sh(
        JSON.stringify({ type: "http", url, headersHelper: helper }),
      )}`,
      hint: `the header helper reads ${f} each time Claude Code connects; user scope, so no workspace trust is needed`,
      verify: `\`claude mcp list\` shows ${NAME} as connected.`,
      reload: "Start a new Claude Code session, or reconnect from `/mcp`.",
    },
    {
      agent: "Codex CLI",
      variant: "token",
      language: "toml",
      file: "~/.codex/config.toml",
      code: `[mcp_servers.${NAME}]\nurl = ${toml(url)}\nhttp_headers_helper = ${toml(helper)}`,
      hint: "needs Codex 0.163 or later; older versions: use OAuth",
      verify: `\`codex mcp list\` shows ${NAME}.`,
      reload:
        "Restart codex (CLI, IDE extension or app); it reads its config at start.",
    },
    {
      agent: "OpenCode",
      variant: "token",
      language: "json",
      file: "opencode.json",
      code: json({
        mcp: {
          [NAME]: {
            type: "remote",
            url,
            oauth: false,
            headers: { Authorization: `Bearer {file:${f}}` },
          },
        },
      }),
      hint: "OpenCode can run as a background service that doesn't read your shell profile; the file reference works either way. Don't run `opencode service …` from inside an OpenCode session: it restarts the server you're running in",
      verify: `\`opencode mcp list\` shows ${NAME} as connected.`,
      reload: "Restart opencode; it reads its config at start.",
    },
    {
      agent: "Generic",
      variant: "token",
      language: "json",
      code: json({
        mcpServers: {
          [NAME]: {
            type: "http",
            url,
            headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
          },
        },
      }),
      hint: `read the token from ${f} at connect time; never paste it into a config file`,
      verify: GENERIC_VERIFY,
      reload: GENERIC_RELOAD,
    },
  ];
  return [...oauth, ...token];
}

/**
 * The dashboard's form (unchanged until Frontend switches to tokenFile):
 * token variants read `OA_TOKEN` from the environment.
 */
function envClients(mcpUrl: string): Snippet[] {
  const out: Snippet[] = [];
  for (const variant of ["oauth", "token"] as const) {
    const t = variant === "token";
    const add = (s: Omit<Snippet, "variant">) =>
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
      code: t
        ? `read -rs OA_TOKEN
claude mcp add --transport http ${NAME} ${sh(mcpUrl)} --header "Authorization: Bearer $OA_TOKEN"
unset OA_TOKEN`
        : `claude mcp add --transport http ${NAME} ${sh(mcpUrl)}`,
      hint: "paste the token at the hidden prompt; Claude Code stores the expanded header in its own config",
      verify: t
        ? `\`claude mcp list\` shows ${NAME} as connected.`
        : `In a session, run \`/mcp\`, pick ${NAME} and sign in through the browser; it then lists its tools.`,
      reload: "Start a new Claude Code session, or reconnect from `/mcp`.",
    });
    add({
      agent: "Codex CLI",
      language: "toml",
      code: `[mcp_servers.${NAME}]\nurl = ${toml(mcpUrl)}${t ? `\nbearer_token_env_var = "OA_TOKEN"` : ""}`,
      file: "~/.codex/config.toml",
      hint: "export OA_TOKEN in the shell that starts codex",
      verify: t
        ? `\`codex mcp list\` shows ${NAME}.`
        : `\`codex mcp login ${NAME}\` signs in through the browser; \`codex mcp list\` then shows it.`,
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
      hint: "export OA_TOKEN before launching Cursor",
      verify: t
        ? `Customize (sidebar) shows ${NAME} enabled with its tools.`
        : CURSOR_VERIFY_OAUTH,
      reload: CURSOR_RELOAD,
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
                  headers: { Authorization: "Bearer {env:OA_TOKEN}" },
                }
              : {}),
          },
        },
      }),
      file: "opencode.json",
      hint: "export OA_TOKEN before launching OpenCode; an unset OA_TOKEN becomes an empty string",
      verify: t
        ? `\`opencode mcp list\` shows ${NAME} as connected.`
        : `\`opencode mcp auth ${NAME}\` signs in through the browser; \`opencode mcp list\` then shows it.`,
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
      hint: `replace ${TOKEN_PLACEHOLDER} with your token; keep this file out of git`,
      verify: GENERIC_VERIFY,
      reload: GENERIC_RELOAD,
    });
  }
  return out;
}
