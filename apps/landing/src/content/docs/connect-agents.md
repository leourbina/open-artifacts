---
title: Connect agents
description: Add your instance to Claude Code, Codex CLI, Cursor, OpenCode, or any MCP client.
order: 2
---

Every instance serves one MCP server at `https://<your-app-host>/mcp` over Streamable HTTP. Any MCP client can connect in one of two ways:

- **OAuth.** Clients that support MCP OAuth need only the URL. They register themselves, and you sign in through your instance's login page.
- **Personal access token.** For clients and scripts without OAuth, create a token in the dashboard under **Settings → Agents** and send it as `Authorization: Bearer oa_pat_…`. Tokens can be revoked at any time.

The dashboard's **Settings → Agents** page shows each snippet below with your URL filled in. The examples use `artifacts.example.com`.

## Steps

1. **Pick the auth method.** Use OAuth if this agent's client supports MCP OAuth. Otherwise ask the user to create a personal access token in the dashboard under **Settings → Agents**.
2. **Add the server** to this agent's MCP config, using the snippet for its client in [Connect agents](/docs/connect-agents/). Name the server `open-artifacts`.
3. **Check the connection** by calling `list_artifacts`.

## Claude Code

```sh
claude mcp add --transport http open-artifacts https://artifacts.example.com/mcp \
  --header "Authorization: Bearer oa_pat_..."
```

## Codex CLI

In `~/.codex/config.toml`, with the token in the `OA_TOKEN` environment variable:

```toml
[mcp_servers.open-artifacts]
url = "https://artifacts.example.com/mcp"
bearer_token_env_var = "OA_TOKEN"
```

## Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "open-artifacts": {
      "url": "https://artifacts.example.com/mcp",
      "headers": { "Authorization": "Bearer oa_pat_..." }
    }
  }
}
```

## OpenCode

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "open-artifacts": {
      "type": "remote",
      "url": "https://artifacts.example.com/mcp",
      "headers": { "Authorization": "Bearer oa_pat_..." }
    }
  }
}
```

## Other clients

Give the client the URL `https://artifacts.example.com/mcp`. If it supports OAuth, that's all it needs. Otherwise add the header `Authorization: Bearer oa_pat_...`.

Each version an agent publishes records the client's name and version, or the token's label, so you can see which agent made what.
