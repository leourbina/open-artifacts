import { describe, expect, it } from "vitest";
import { agentClients, TOKEN_PLACEHOLDER } from "../src/agent-clients.js";
import {
  DEFAULT_INSTALL_NAME,
  hostSlug,
  SECRET_ENV_VARS,
  SECRET_LABELS,
  secretFile,
  secretRules,
  secretSnippet,
} from "../src/secrets.js";

describe("secrets", () => {
  it("secretFile: install-name files and the host's PAT file", () => {
    expect(secretFile("cloudflare")).toBe(
      `~/.open-artifacts/${DEFAULT_INSTALL_NAME}-cloudflare-token`,
    );
    expect(secretFile("analytics", { installName: "acme" })).toBe(
      "~/.open-artifacts/acme-analytics-token",
    );
    expect(secretFile("pat", { hostSlug: hostSlug("Oa.Example.com") })).toBe(
      "~/.open-artifacts/oa-example-com-pat-token",
    );
    expect(() => secretFile("pat")).toThrow();
  });

  it("secretSnippet is Platform's template (scripts/setup/src/tokens.ts), pinned", () => {
    expect(
      secretSnippet(
        "~/.open-artifacts/open-artifacts-staging-cloudflare-token",
        "Cloudflare deploy token",
      ),
    ).toBe(
      `bash -c 'set -e; umask 077; d="$HOME/.open-artifacts"; mkdir -p "$d"; chmod 700 "$d"; read -rsp "Cloudflare deploy token (hidden, then Enter): " T; echo; [ -n "$T" ] || { echo "nothing entered; not saved"; exit 1; }; rm -f "$d/open-artifacts-staging-cloudflare-token"; printf "%s" "$T" > "$d/open-artifacts-staging-cloudflare-token"; chmod 600 "$d/open-artifacts-staging-cloudflare-token"; echo "saved to $d/open-artifacts-staging-cloudflare-token"'`,
    );
  });

  it("secretRules: env var inside the command, or a given usage; no --token-file", () => {
    const file = secretFile("cloudflare");
    const env = secretRules({ file, envVar: SECRET_ENV_VARS.cloudflare });
    expect(env).toContain(
      `\`CLOUDFLARE_API_TOKEN="$(cat ${file})" pnpm -s oa:setup …\``,
    );
    const usage = secretRules({ file, usage: "X=1 cmd" });
    expect(usage).toContain("`X=1 cmd`");
    expect(env + usage).not.toContain("--token-file");
  });
});

describe("agentClients", () => {
  const URL_ = "https://oa.example.com/mcp";
  const FILE = "~/.open-artifacts/oa-example-com-pat-token";

  it("5 agents per variant, oauth first, each with verify and reload", () => {
    const all = agentClients(URL_);
    const agents = [
      "Claude Code",
      "Codex CLI",
      "Cursor",
      "OpenCode",
      "Generic",
    ];
    expect(all.map((s) => `${s.variant}:${s.agent}`)).toEqual([
      ...agents.map((a) => `oauth:${a}`),
      ...agents.map((a) => `token:${a}`),
    ]);
    for (const s of all) {
      expect(s.verify).toBeTruthy();
      expect(s.reload).toBeTruthy();
    }
  });

  it("with tokenFile, token variants read the file and never inline a token", () => {
    const tok = agentClients(URL_, { tokenFile: FILE }).filter(
      (s) => s.variant === "token",
    );
    const by = (a: string) => tok.find((s) => s.agent === a);
    expect(by("Claude Code")?.code).toContain(
      "--header 'Authorization: Bearer ${OA_TOKEN}'",
    );
    expect(by("Claude Code")?.hint).toContain(
      `OA_TOKEN="$(cat ${FILE})" claude`,
    );
    expect(by("OpenCode")?.code).toContain(`{file:${FILE}}`);
    expect(by("Codex CLI")?.hint).toContain(`OA_TOKEN="$(cat ${FILE})" codex`);
    expect(by("Cursor")?.hint).toContain(`$(cat ${FILE})`);
    expect(by("Generic")?.code).toContain(TOKEN_PLACEHOLDER);
    for (const s of tok) {
      expect(s.code).not.toContain("oa_pat_");
      // Stored configs and add commands never expand the token; only a
      // launch-command note may.
      expect(s.code, s.agent).not.toContain("$(cat");
    }
  });

  it("without tokenFile, token variants read OA_TOKEN (the dashboard's form)", () => {
    for (const s of agentClients(URL_).filter((s) => s.variant === "token"))
      expect(s.code).toMatch(/OA_TOKEN|<YOUR_TOKEN>/);
  });
});
