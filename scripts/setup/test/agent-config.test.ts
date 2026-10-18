import { describe, expect, it } from "vitest";
import { NOTES, snippets } from "../src/steps/agent-config.ts";

const URL = "https://app.example.com/mcp";

describe("agent-config snippets", () => {
  const s = snippets("open-artifacts", URL);
  it("every JSON snippet parses with JSON.parse", () => {
    for (const k of ["cursor", "opencode", "json"] as const)
      expect(() => JSON.parse(s[k]), k).not.toThrow();
  });
  it("TOML snippet has no // beyond the URL", () => {
    expect(s.codex.replaceAll("://", "")).not.toContain("//");
    expect(s.codex).toContain("[mcp_servers.open-artifacts]");
    expect(s.codex).toContain('bearer_token_env_var = "OA_TOKEN"');
  });
  it("claude is read -rs then a double-quoted header using $OA_TOKEN", () => {
    expect(s.claudeCode).toContain("read -rs OA_TOKEN");
    expect(s.claudeCode).toContain(
      `--header "Authorization: Bearer $OA_TOKEN"`,
    );
    expect(s.claudeCode).not.toMatch(/oa_pat_/);
  });
  it("cursor and opencode use their documented env interpolation", () => {
    expect(JSON.parse(s.cursor).mcpServers["open-artifacts"].headers).toEqual({
      Authorization: "Bearer ${env:OA_TOKEN}",
    });
    expect(JSON.parse(s.opencode).mcp["open-artifacts"].headers).toEqual({
      Authorization: "Bearer {env:OA_TOKEN}",
    });
  });
  it("generic JSON uses the placeholder", () => {
    expect(JSON.parse(s.json).mcpServers["open-artifacts"].headers).toEqual({
      Authorization: "Bearer <YOUR_TOKEN>",
    });
  });
  it("codex snippet contains no PAT", () => {
    expect(s.codex).not.toMatch(/oa_pat_/);
  });
  it("opencode JSON sets oauth: false and notes the empty-string behavior", () => {
    expect(JSON.parse(s.opencode).mcp["open-artifacts"].oauth).toBe(false);
    expect(NOTES.opencode).toContain("empty string");
  });
  it("claude snippet ends with unset OA_TOKEN and notes the stored header", () => {
    expect(s.claudeCode.trimEnd().endsWith("unset OA_TOKEN")).toBe(true);
    expect(NOTES.claudeCode).toContain("its own config");
  });
});
