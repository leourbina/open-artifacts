// The global bootstrap Agent Skill served at /skill.md. Thin on purpose: it
// only finds or installs an instance and hands off to that instance's own
// /skill.md, which carries the tools and limits. The Secrets section comes
// from the server's skill-common.ts so the one-liner and rules never drift.
import {
  secretRules,
  secretSnippet,
} from "../../../server/src/mcp/skill-common.ts";

const SITE = "https://open-artifacts.com";
const SECRET = "cloudflare";

export const skillMd = (): string => `---
name: open-artifacts
description: "Open Artifacts: publish and share web pages, documents, code and PDFs on the user's own Open Artifacts instance. Use when the user mentions Open Artifacts, or asks to publish, host or share a page or file there, and no instance-specific open-artifacts-<host> skill is installed yet. Finds or installs the user's instance, then installs that instance's skill."
---

# Open Artifacts

Open Artifacts is a self-hosted place where any AI agent can publish pages, documents and code and share them by link. Each instance serves its own skill with its tools and limits. This skill only gets that skill installed.

## Steps

1. Ask the user whether they already have an Open Artifacts instance.
2. If they do, ask for its URL (for example \`https://artifacts.example.com\`). Fetch \`<url>/skill.md\` and install it as a skill in your agent's skills directory, under the \`name\` in its frontmatter (it looks like \`open-artifacts-<host>\`). Then follow that skill from here on.
3. If they do not, follow ${SITE}/llms.txt to install an instance for them. When it is running, do step 2 with the new instance URL.
4. Keep this skill: it is how you reach a second instance, or reinstall one.

## Secrets

Installing an instance needs the user's Cloudflare API token. To save it, give the user this line:

\`\`\`sh
${secretSnippet(SECRET)}
\`\`\`

${secretRules(SECRET)}
`;
