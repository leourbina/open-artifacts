import fallback from "../data/tools.fallback.json";

export interface Tool {
  name: string;
  description: string;
}

// The server emits the manifest at build time (B14). Until then, use the
// spec §6.6 list. TODO(B14): drop the fallback once tool-manifest.json lands.
const manifests = import.meta.glob<Tool[]>(
  "../../../server/src/mcp/tool-manifest.json",
  { eager: true, import: "default" },
);

export const tools: Tool[] = Object.values(manifests)[0] ?? fallback;
