// Renders the /skill.md template from TOOL_DEFS and the INSTRUCTIONS sections.
// Build time only (scripts/emit-skill.ts writes skill.generated.ts; the drift
// test re-renders it): the Worker never runs this. Plain Node-loadable.

import { agentClients, type Snippet } from "@oa/shared";
import { z } from "zod";
import { renderSections } from "./instructions.ts";
import {
  SECRET_LABELS,
  secretFile,
  secretRules,
  secretSnippet,
} from "./skill-common.ts";
import { TOOL_DEFS } from "./tool-defs.ts";

/** Tokens skill.ts fills at request time (one pass, memoized per isolate). */
export const SKILL_TOKENS = [
  "origin",
  "host",
  "name",
  "hostSlug",
  "plan",
  "dataDoc",
  "dataDocNote",
  "mcpBody",
  "quota",
  "version",
] as const;
export type SkillToken = (typeof SKILL_TOKENS)[number];

const T = (k: SkillToken) => `{{${k}}}`;

type Json = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: Json[];
  oneOf?: Json[];
  properties?: Record<string, Json>;
  required?: string[];
  additionalProperties?: Json | boolean;
  default?: unknown;
};

/** A compact type for one JSON Schema node: string, "a"|"b", string | object. */
function typeOf(s: Json): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join("|");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const alt = s.anyOf ?? s.oneOf;
  const types = alt
    ? [...new Set(alt.map(typeOf))]
    : Array.isArray(s.type)
      ? s.type
      : null;
  if (types) {
    // boolean | z.stringbool(): the string form only coerces REST query
    // strings ("true"); over MCP it is a boolean.
    if (
      types.length === 2 &&
      types.includes("boolean") &&
      types.includes("string")
    )
      return "boolean";
    return types.join(" | ");
  }
  const ap = s.additionalProperties;
  if (s.type === "object" && typeof ap === "object")
    return `{ "<key>": ${typeOf(ap)} }`;
  if (s.type === "object" && s.properties)
    return `{ ${Object.keys(s.properties).join(", ")} }`;
  return typeof s.type === "string" ? s.type : "any";
}

/** One line: `name` type, `opt?` type = default, ... */
function params(schema: z.ZodType): string {
  const js = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Json;
  const req = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {})
    .map(([k, v]) => {
      const d =
        v.default !== undefined ? ` = ${JSON.stringify(v.default)}` : "";
      return `\`${k}${req.has(k) ? "" : "?"}\` ${typeOf(v)}${d}`;
    })
    .join(", ");
}

const tools = (): string =>
  TOOL_DEFS.map(
    (t) => `### ${t.name}

${t.description}

Parameters (? = optional): ${params(t.inputSchema)}

\`\`\`json
${JSON.stringify(t.example)}
\`\`\``,
  ).join("\n\n");

const PAT_FILE = secretFile("pat", { hostSlug: T("hostSlug") });
const MCP_URL = `${T("origin")}/mcp`;

const snippetBlock = (s: Snippet, label: string) =>
  [
    `${label}${s.file ? ` (in \`${s.file}\`)` : ""}:`,
    "",
    `\`\`\`${s.language === "bash" ? "sh" : s.language}`,
    s.code,
    "```",
    "",
    ...(s.hint ? [`Note: ${s.hint}.`, ""] : []),
    `Verify: ${s.verify}`,
  ].join("\n");

/** Per client: OAuth and token setup, verify and reload (agentClients). */
export const clientsSection = (): string => {
  const all = agentClients(MCP_URL, { tokenFile: PAT_FILE });
  const agents = [...new Set(all.map((s) => s.agent))];
  return agents
    .map((a) => {
      const oauth = all.find((s) => s.agent === a && s.variant === "oauth");
      const token = all.find((s) => s.agent === a && s.variant === "token");
      return [
        `### ${a}`,
        oauth && snippetBlock(oauth, "OAuth"),
        token && snippetBlock(token, "Token"),
        `Reload: ${token?.reload ?? oauth?.reload}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
};

export function renderSkillTemplate(): string {
  const plan = {
    plan: T("plan"),
    dataDoc: T("dataDoc"),
    dataDocNote: T("dataDocNote"),
    mcpBody: T("mcpBody"),
    quota: T("quota"),
  };
  return `---
name: ${T("name")}
description: "Open Artifacts (${T("host")}): publish and share web pages, documents, code and PDFs on ${T("host")}, the user's own Open Artifacts instance, through its MCP tools. Use when the user asks to publish, host, share or send a link to an HTML page, site, report, doc, diagram, dashboard or file; to update, list, search or restore artifacts and versions; to change who can see one; or to read and write a live page's data."
compatibility: "Requires an MCP client with HTTP transport, or curl"
metadata:
  version: "${T("version")}"
  instance: "${T("host")}"
  plan: "${T("plan")}"
---

# Open Artifacts (${T("host")})

Skill version ${T("version")} for ${T("origin")} (${T("plan")} plan). If the server's tools/list differs from the Tools section below, fetch ${T("origin")}/skill.md again and replace this skill with it.

Open Artifacts hosts the pages, documents and code you publish, with versions, sharing and live data. Each artifact gets a stable URL on ${T("origin")}; every publish adds a version.

## Connect

- MCP endpoint: \`${T("origin")}/mcp\` (Streamable HTTP).
- OAuth (preferred): add \`${T("origin")}/mcp\` as a remote MCP server in your client. The client registers itself (dynamic client registration) and the user signs in through the browser.
- Personal access token: the user creates one at ${T("origin")}/settings/agents and saves it with the line under Secrets. Send it as \`Authorization: Bearer <token>\`, read from \`${PAT_FILE}\` in the command or config, never pasted in.
- Per-client setup is under Client setup below; after a change, reload the client and check that tools/list shows the ${TOOL_DEFS.length} tools.
- Only members can connect agents; guests cannot.
- Without MCP support, call the endpoint with curl (JSON-RPC; \`tools/call\` takes \`{ "name": "<tool>", "arguments": { ... } }\`):

\`\`\`sh
curl -s ${T("origin")}/mcp -H "Authorization: Bearer $(cat ${PAT_FILE})" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

## Secrets

To save the user's personal access token, give them this line:

\`\`\`sh
${secretSnippet(PAT_FILE, SECRET_LABELS.pat)}
\`\`\`

${secretRules({ file: PAT_FILE, usage: `-H "Authorization: Bearer $(cat ${PAT_FILE})"` })}

## Client setup

${clientsSection()}

## Tools

${tools()}

${renderSections(plan, (t) => `## ${t}\n`)}

## What to tell the user

- After a publish: the view URL from the result, the version, and who can open it. New artifacts are private (or team, if an admin changed the default); offer share_artifact or set_visibility.
- After a share: the result says whether ${T("host")} emailed the person a link; if not, give the user the URL to send.
- After a delete: it can be restored from the dashboard at ${T("origin")} for 30 days.
- Pass on quota_exceeded and CPU-limit notes as they are; the fix is the instance owner's.
- Never show a token, even one you just read from a file.
`;
}
