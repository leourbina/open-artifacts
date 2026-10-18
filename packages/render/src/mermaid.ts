import type { Theme } from "@oa/shared";

const VARS: Record<Theme, Record<string, string>> = {
  light: {
    background: "#ffffff",
    primaryColor: "#f6f7f9",
    primaryBorderColor: "#848b95",
    primaryTextColor: "#15181c",
    lineColor: "#5f6670",
    secondaryColor: "#e7edfc",
    tertiaryColor: "#ffffff",
    edgeLabelBackground: "#ffffff",
  },
  dark: {
    background: "#1c1f23",
    primaryColor: "#212429",
    primaryBorderColor: "#676e78",
    primaryTextColor: "#e9ebee",
    lineColor: "#9097a1",
    secondaryColor: "#1f2a4a",
    tertiaryColor: "#1c1f23",
    edgeLabelBackground: "#1c1f23",
  },
};

const sources = new WeakMap<Element, string>();

let chain: Promise<void> = Promise.resolve();

/**
 * Render every pre.mermaid under root; mermaid is imported only when one exists.
 * Runs are serialized so rapid theme flips never overlap.
 */
export function renderMermaid(root: ParentNode, theme: Theme): Promise<void> {
  const run = chain.then(() => runMermaid(root, theme));
  chain = run.catch(() => undefined);
  return run;
}

async function runMermaid(root: ParentNode, theme: Theme): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (nodes.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      ...VARS[theme],
      fontFamily: "Geist, ui-sans-serif, sans-serif",
      fontSize: "14px",
    },
  });
  for (const n of nodes) {
    const src = sources.get(n) ?? n.textContent ?? "";
    sources.set(n, src);
    n.removeAttribute("data-processed");
    n.textContent = src;
  }
  await mermaid.run({ nodes, suppressErrors: true });
}
