// Writes src/mcp/tool-manifest.json ([{ name, description }] for every MCP tool),
// consumed by the landing site. Gitignored: `pnpm gen` writes it; the
// package's build, test, test:cpu, bench and typecheck, and the landing's
// build, typecheck and test, run that first.
import path from "node:path";
import { TOOL_DEFS } from "../src/mcp/tool-defs.ts";
import { writeGenerated } from "./write-generated.ts";

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
writeGenerated(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `wrote ${manifest.length} tools to ${path.relative(process.cwd(), out)}`,
);
