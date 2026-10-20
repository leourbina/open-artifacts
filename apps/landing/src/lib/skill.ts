// The global bootstrap Agent Skill served at /skill.md. Thin on purpose: it
// only finds or installs an instance and hands off to that instance's own
// /skill.md, which carries the tools and limits. The Secrets section comes
// from @oa/shared's secrets helpers so the one-liner and rules never drift.
import {
  DEFAULT_INSTALL_NAME,
  SECRET_ENV_VARS,
  SECRET_LABELS,
  secretFile,
  secretRules,
  secretSnippet,
} from "@oa/shared";

const SITE = "https://open-artifacts.com";
const FILE = secretFile("cloudflare", { installName: DEFAULT_INSTALL_NAME });

export const SKILL_SECRET = {
  snippet: secretSnippet(FILE, SECRET_LABELS.cloudflare),
  rules: secretRules({
    file: FILE,
    envVar: SECRET_ENV_VARS.cloudflare,
    command: "pnpm -s oa:setup …",
  }),
};

export const skillMd = (): string => `---
name: open-artifacts
description: "Open Artifacts: publish and share web pages, documents, code and PDFs on the user's own Open Artifacts instance. Use when the user mentions Open Artifacts, or asks to publish, host or share a page or file there, and no instance-specific open-artifacts-<host> skill is installed yet. Finds or installs the user's instance, then installs that instance's skill."
---

# Open Artifacts

Open Artifacts is a self-hosted place where any AI agent can publish pages, documents and code and share them by link. Each instance serves its own skill with its tools and limits. This skill only gets that skill installed.

## Steps

1. Ask the user whether they already have an Open Artifacts instance.
2. If they do, ask for its URL (for example \`https://artifacts.example.com\`). Fetch \`<url>/skill.md\` and install it as a skill in your agent's skills directory, under the \`name\` in its frontmatter (it looks like \`open-artifacts-<host>\`). Then follow that skill from here on.
3. If they do not, follow ${SITE}/llms.txt to install an instance for them. Pick the install name first (default \`${DEFAULT_INSTALL_NAME}\`) and pass \`--name <name>\` to setup. When it is running, do step 2 with the new instance URL.
4. Keep this skill: it is how you reach a second instance, or reinstall one.

## Secrets

Installing an instance needs the user's Cloudflare deploy token. To save it, give the user this line:

\`\`\`sh
${SKILL_SECRET.snippet}
\`\`\`

${SKILL_SECRET.rules}
- With an install name other than \`${DEFAULT_INSTALL_NAME}\`, the file is \`~/.open-artifacts/<name>-cloudflare-token\`: change the file name in the line and the command to match.
`;
