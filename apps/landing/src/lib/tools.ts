import fallback from "../data/tools.fallback.json";

export interface Tool {
  name: string;
  description: string;
}

// The server emits the manifest at build time (B14). Until then, use the
// spec §6.6 list, and mark the build so the release gate blocks it.
export function selectTools(manifests: Tool[][]): {
  tools: Tool[];
  isFallback: boolean;
} {
  const manifest = manifests[0];
  return manifest
    ? { tools: manifest, isFallback: false }
    : { tools: fallback, isFallback: true };
}

const found = import.meta.glob<Tool[]>(
  "../../../server/src/mcp/tool-manifest.json",
  { eager: true, import: "default" },
);

export const { tools, isFallback: toolsAreFallback } = selectTools(
  Object.values(found),
);
