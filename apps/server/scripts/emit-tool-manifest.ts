// Writes src/mcp/tool-manifest.json ([{ name, description }] for every MCP tool),
// consumed by the landing site. Run by `pnpm build`; the file is committed and
// test/mcp.tools.test.ts fails when it is stale.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { TOOL_DEFS } from "../src/mcp/tool-defs.ts";

const out = path.join(
  import.meta.dirname,
  "..",
  "src",
  "mcp",
  "tool-manifest.json",
);
const manifest = TOOL_DEFS.map(({ name, description }) => ({
  name,
  description,
}));
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `wrote ${manifest.length} tools to ${path.relative(process.cwd(), out)}`,
);
