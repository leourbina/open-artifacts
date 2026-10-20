import { patTokenFileTilde } from "../secret-file.ts";
import type { Step } from "../step.ts";

const PLACEHOLDER = "<YOUR_TOKEN>";
const cursorHeaders = { Authorization: "Bearer ${env:OA_TOKEN}" };

/**
 * MCP client snippets for a streamable-HTTP server with a bearer header.
 * Never embeds a token. Env interpolation, per official docs:
 * Cursor `${env:NAME}` (https://cursor.com/docs/context/mcp),
 * OpenCode `{env:NAME}` (https://opencode.ai/docs/config/),
 * Codex `bearer_token_env_var` (https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
 */
export function snippets(name: string, url: string) {
  const pretty = (v: unknown) => JSON.stringify(v, null, 2);
  const opencodeHeaders = { Authorization: "Bearer {env:OA_TOKEN}" };
  const headers = { Authorization: `Bearer ${PLACEHOLDER}` };
  return {
    claudeCode: `read -rs OA_TOKEN\nclaude mcp add --transport http ${name} ${url} --header "Authorization: Bearer $OA_TOKEN"\nunset OA_TOKEN`,
    codex: `[mcp_servers.${name}]\nurl = "${url}"\nbearer_token_env_var = "OA_TOKEN"`,
    cursor: pretty({
      mcpServers: { [name]: { url, headers: cursorHeaders } },
    }),
    opencode: pretty({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [name]: {
          type: "remote",
          url,
          enabled: true,
          oauth: false,
          headers: opencodeHeaders,
        },
      },
    }),
    json: pretty({ mcpServers: { [name]: { type: "http", url, headers } } }),
  };
}

/** One-line notes shown above a block. */
export const NOTES: Record<string, string> = {
  claudeCode:
    "paste the token at the hidden prompt; Claude Code stores the expanded header in its own config",
  codex: "export OA_TOKEN in the shell that starts codex",
  cursor: "export OA_TOKEN before launching Cursor",
  opencode:
    "export OA_TOKEN before launching OpenCode; an unset OA_TOKEN becomes an empty string",
  json: `replace ${PLACEHOLDER} with your token; keep this file out of git`,
};

/**
 * MCP client snippets for a streamable-HTTP server with a bearer header.
 * Never embeds a token: they read the PAT file setup saved (`tokenFile`).
 * Claude Code expands `$(cat <file>)` once when you add the server; OpenCode
 * reads `{file:<file>}` (https://opencode.ai/docs/config/). Codex
 * (`bearer_token_env_var`, https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
 * and Cursor (`${env:NAME}`, https://cursor.com/docs/context/mcp) only read the
 * environment, so they take OA_TOKEN exported from the file.
 */
export function fileSnippets(name: string, url: string, tokenFile: string) {
  const pretty = (v: unknown) => JSON.stringify(v, null, 2);
  const opencodeHeaders = { Authorization: `Bearer {file:${tokenFile}}` };
  const headers = { Authorization: `Bearer ${PLACEHOLDER}` };
  return {
    claudeCode: `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer $(cat ${tokenFile})"`,
    codex: `[mcp_servers.${name}]\nurl = "${url}"\nbearer_token_env_var = "OA_TOKEN"`,
    cursor: pretty({
      mcpServers: { [name]: { url, headers: cursorHeaders } },
    }),
    opencode: pretty({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [name]: {
          type: "remote",
          url,
          enabled: true,
          oauth: false,
          headers: opencodeHeaders,
        },
      },
    }),
    json: pretty({ mcpServers: { [name]: { type: "http", url, headers } } }),
  };
}

/** One-line notes shown above a block. */
export const fileNotes = (tokenFile: string): Record<string, string> => ({
  claudeCode: `run it as is; the shell reads ${tokenFile} and Claude Code stores the expanded header in its own config`,
  codex: `start codex from a shell that did: export OA_TOKEN="$(cat ${tokenFile})"`,
  cursor: `start Cursor from a shell that did: export OA_TOKEN="$(cat ${tokenFile})"`,
  opencode: `OpenCode reads ${tokenFile} itself`,
  json: `replace ${PLACEHOLDER} with the contents of ${tokenFile} yourself; keep this file out of git`,
});

/** Where each snippet goes; null when it is a command or client-specific. */
const PATHS: Record<string, string | null> = {
  claudeCode: null,
  codex: "~/.codex/config.toml",
  cursor: ".cursor/mcp.json",
  opencode: "opencode.json",
  json: null,
};

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
    await agentConfig.apply(_state, ctx);
    return "done";
  },
  async apply(_state, ctx) {
    const url = `https://${ctx.opts.appHost}/mcp`;
    const tokenFile = patTokenFileTilde(ctx.opts.appHost);
    const s = fileSnippets(ctx.opts.name, url, tokenFile);
    const NOTES = fileNotes(tokenFile);
    const welcomeUrl = ctx.welcomeUrl;
    const configs = Object.entries(s).map(([k, snippet]) => ({
      client: TITLES[k as keyof typeof s],
      path: PATHS[k],
      note: NOTES[k],
      snippet,
    }));
    const ci = ctx.opts.ci;
    const tokenNote = ci
      ? "create a token in the dashboard (Settings → Tokens)"
      : undefined;
    ctx.data = {
      url,
      ...(tokenNote ? { tokenNote } : {}),
      snippets: s,
      configs,
      ...(welcomeUrl ? { welcomeUrl } : {}),
    };
    const welcome = welcomeUrl ? `\n  Welcome artifact: ${welcomeUrl}\n` : "";
    ctx.human =
      welcome +
      (ci
        ? "\n  Token: create a token in the dashboard (Settings → Tokens); snippets never embed it."
        : `\n  Token: saved to ${tokenFile} by the owner-token step; snippets read that file and never embed it.`) +
      Object.entries(s)
        .map(
          ([k, v]) =>
            `\n  ${TITLES[k as keyof typeof s]} (${NOTES[k]}):\n${(
              PATHS[k] ? `# ${PATHS[k]}\n${v}` : v
            ).replace(/^/gm, "    ")}`,
        )
        .join("\n");
    return undefined;
  },
};
