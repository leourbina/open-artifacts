import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolsAreFallback } from "./tools";

// Features the docs describe that a release may not ship yet. Each active gate
// marks the pages that depend on it, and Platform's release gate blocks the
// production deploy while dist/ contains "TODO" or "OA-UNRELEASED".
// Every gate is automatic: it reads the code it depends on at build time.

/** Where a gate's markers go: the landing page, a doc id, or the llms files. */
type Page = "index" | "llms" | string;

export const GATES = {
  B14: {
    label: "B14 tool list",
    todo: "TODO(B14): fallback tool list",
    pages: ["index", "mcp-tools", "connect-agents", "llms"],
  },
  OAUTH: {
    label: "MCP OAuth",
    todo: "TODO(OAuth): MCP OAuth is not served",
    pages: ["connect-agents", "security", "llms"],
  },
  AGENTS_PAGE: {
    label: "Settings Agents page",
    todo: "TODO(FE): Settings Agents page is a placeholder",
    pages: ["connect-agents", "security", "llms"],
  },
  USAGE_PAGE: {
    label: "Usage page",
    todo: "TODO(FE): Usage page is a placeholder",
    pages: ["index", "self-hosting-costs"],
  },
} as const satisfies Record<
  string,
  { label: string; todo: string; pages: readonly Page[] }
>;

export type GateId = keyof typeof GATES;

export const UNRELEASED = "OA-UNRELEASED";

/** True when some server source imports the MCP OAuth provider. */
export const servesOAuth = (sources: string[]) =>
  sources.some((s) =>
    /from\s+["']@cloudflare\/workers-oauth-provider["']/.test(s),
  );

/** True while the dashboard router renders `title` with its placeholder page. */
export const isPlaceholder = (router: string, title: string) =>
  router.includes(`page("${title}")`) ||
  router.includes(`<Placeholder title="${title}" />`);

/** The nearest directory up from `from` that holds pnpm-workspace.yaml. */
function repoRoot(from = process.cwd()): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir)
      throw new Error("no pnpm-workspace.yaml above cwd");
  }
}

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

const root = repoRoot();
const routerPath = join(root, "apps/dashboard/src/router.tsx");
const router = existsSync(routerPath) ? readFileSync(routerPath, "utf8") : "";

export const activeGates: Record<GateId, boolean> = {
  // Off once the server's tool manifest exists.
  B14: toolsAreFallback,
  OAUTH: !servesOAuth(sources(join(root, "apps/server/src"))),
  AGENTS_PAGE: !router || isPlaceholder(router, "Agents"),
  USAGE_PAGE: !router || isPlaceholder(router, "Usage"),
};

/** The active gates for one page, in GATES order. */
export const gatesFor = (page: Page): GateId[] =>
  (Object.keys(GATES) as GateId[]).filter(
    (id) =>
      activeGates[id] && (GATES[id].pages as readonly Page[]).includes(page),
  );
