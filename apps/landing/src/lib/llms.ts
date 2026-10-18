import { type CollectionEntry, getCollection } from "astro:content";
import { tools } from "./tools";

export const SITE = "https://open-artifacts.com";

export const SUMMARY =
  "Open Artifacts is an open-source, self-hosted place to keep, version, and share what AI agents make: HTML pages, Markdown docs, code, and PDFs. The user deploys it to their own Cloudflare account and domain, and any MCP-capable agent publishes to it. You, the agent, can do the whole setup; the only step for the user is the Cloudflare login.";

export type Doc = CollectionEntry<"docs">;

export async function docs(): Promise<Doc[]> {
  return (await getCollection("docs")).sort(
    (a, b) => a.data.order - b.data.order,
  );
}

// Fill placeholders and point site links at the Markdown copies agents read.
export function agentMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->\n*/g, "")
    .replace(/\]\(\/docs\/([a-z-]+)\/\)/g, `](${SITE}/docs/$1.md)`)
    .trim();
}

// The body of a `## heading` section, up to the next `## ` heading.
export function section(doc: Doc, heading: string): string {
  const body = agentMarkdown(doc.body ?? "");
  const start = body.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`${doc.id}.md has no "## ${heading}"`);
  const rest = body.slice(start + heading.length + 5);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export function docMarkdown(doc: Doc): string {
  return `# ${doc.data.title}\n\n> ${doc.data.description}\n\n${agentMarkdown(doc.body ?? "")}\n`;
}

export async function llmsTxt(): Promise<string> {
  const all = await docs();
  const byId = (id: string) => {
    const doc = all.find((d) => d.id === id);
    if (!doc) throw new Error(`missing doc ${id}`);
    return doc;
  };
  return [
    "# Open Artifacts",
    `> ${SUMMARY}`,
    "## Set up Open Artifacts for your user",
    section(byId("setup"), "Steps"),
    "## Update an existing install",
    section(byId("upgrade"), "Steps"),
    "## Connect another agent",
    section(byId("connect-agents"), "Steps"),
    "## Tools",
    tools.map((t) => `- \`${t.name}\`: ${t.description}`).join("\n"),
    "## Docs",
    [
      ...all.map(
        (d) =>
          `- [${d.data.title}](${SITE}/docs/${d.id}.md): ${d.data.description}`,
      ),
      `- [All docs in one file](${SITE}/llms-full.txt)`,
    ].join("\n"),
  ]
    .join("\n\n")
    .concat("\n");
}
