import { describe, expect, it } from "vitest";
import { snippets } from "../src/steps/agent-config.ts";

const URL = "https://app.example.com/mcp";

describe("agent-config snippets", () => {
  for (const token of ["oa_pat_abc123", "<YOUR_TOKEN>"]) {
    const s = snippets("open-artifacts", URL, token);
    describe(`token ${token}`, () => {
      it("every JSON snippet parses with JSON.parse", () => {
        for (const k of ["cursor", "opencode", "json"] as const)
          expect(() => JSON.parse(s[k]), k).not.toThrow();
      });
      it("TOML snippet has no //", () => {
        expect(s.codex.replaceAll("://", "")).not.toContain("//");
        expect(s.codex).toContain("[mcp_servers.open-artifacts]");
      });
      it("claude header is single-quoted, never double-quoted", () => {
        expect(s.claudeCode).toContain(
          `--header 'Authorization: Bearer ${token}'`,
        );
        expect(s.claudeCode).not.toMatch(/--header "/);
      });
      it("token appears in every snippet", () => {
        for (const v of Object.values(s)) expect(v).toContain(token);
      });
    });
  }
});
