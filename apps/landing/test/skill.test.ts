import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BANG_RULE,
  DEFAULT_INSTALL_NAME,
  SECRET_ENV_VARS,
  SECRET_LABELS,
  secretFile,
  secretRules,
  secretSnippet,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "../../server/src/mcp/tool-defs.ts";

// Runs against the built site: `pnpm test` builds first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const skill = readFileSync(`${dist}skill.md`, "utf8");
const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
const field = (k: string) =>
  front.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1]?.replace(/^"|"$/g, "");

describe("skill.md", () => {
  it("has valid Agent Skills frontmatter", () => {
    const name = field("name") ?? "";
    expect(name).toBe("open-artifacts");
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(field("description")?.length).toBeGreaterThan(0);
  });

  it("renders the server's secrets one-liner and rules verbatim", () => {
    const file = secretFile("cloudflare", {
      installName: DEFAULT_INSTALL_NAME,
    });
    expect(file).toBe("~/.open-artifacts/open-artifacts-cloudflare-token");
    const snippet = secretSnippet(file, SECRET_LABELS.cloudflare);
    expect(skill).toContain(`\`\`\`sh\n${snippet}\n\`\`\``);
    expect(skill).toContain(
      secretRules({
        file,
        envVar: SECRET_ENV_VARS.cloudflare,
        command: "pnpm -s oa:setup …",
      }),
    );
    expect(skill).toContain(
      `CLOUDFLARE_API_TOKEN="$(cat ${file})" pnpm -s oa:setup …`,
    );
  });

  it("hands off to the instance skill and the install guide", () => {
    expect(skill).toContain("<url>/skill.md");
    expect(skill).toContain("https://open-artifacts.com/llms.txt");
    expect(skill).toContain("--name <name>");
  });

  it("stays thin and vendor-neutral", () => {
    expect(skill).not.toContain("—");
    expect(skill).not.toMatch(/\d\s*(KB|MB|GB)\b/i);
    expect(skill).not.toMatch(/\b(KB|MB)\b/);
    for (const { name } of TOOL_DEFS) expect(skill).not.toContain(name);
    expect(skill.replace(BANG_RULE, "")).not.toMatch(
      /Claude|Cursor|Codex|Copilot|ChatGPT|Gemini|\.claude/,
    );
  });
});
