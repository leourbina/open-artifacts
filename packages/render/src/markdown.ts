import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import { COPY_BUTTON } from "./code";
import { escapeHtml, highlightSync, loadLanguages } from "./highlight";

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

/** Only http(s), mailto and relative URLs survive; everything else (javascript:, data:, …) is dropped. */
export function isSafeUrl(url: string): boolean {
  // Browsers ignore ASCII whitespace and control characters inside a scheme.
  let clean = "";
  for (const ch of url) {
    const c = ch.charCodeAt(0);
    if (c > 0x20 && (c < 0x7f || c > 0x9f)) clean += ch;
  }
  const m = SCHEME.exec(clean);
  if (!m) return true;
  return SAFE_SCHEMES.has((m[1] as string).toLowerCase());
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
  .use(taskLists, { enabled: false, label: false })
  .use(footnote);
md.validateLink = isSafeUrl;

/** Fences above this, or past the per-document budget, render as escaped plain <pre>. */
export const FENCE_HIGHLIGHT_MAX_BYTES = 64 * 1024;
export const DOC_HIGHLIGHT_MAX_BYTES = 256 * 1024;
const utf8 = new TextEncoder();

interface Env {
  highlighted?: number;
}

md.renderer.rules.fence = (tokens, idx, _options, env: Env) => {
  const token = tokens[idx];
  if (!token) return "";
  const lang = (token.info.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (lang === "mermaid")
    return `<pre class="mermaid">${escapeHtml(token.content)}</pre>\n`;
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
  const bytes = utf8.encode(token.content).length;
  const used = env.highlighted ?? 0;
  let body: string;
  if (
    bytes > FENCE_HIGHLIGHT_MAX_BYTES ||
    used + bytes > DOC_HIGHLIGHT_MAX_BYTES
  )
    body = `<pre><code>${escapeHtml(token.content)}</code></pre>`;
  else {
    env.highlighted = used + bytes;
    body = highlightSync(token.content, lang);
  }
  return `<div class="oa-codeblock"${langAttr}>${body}${COPY_BUTTON}</div>\n`;
};

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token?.attrGet("href") ?? "";
  if (token && /^(https?:)?\/\//i.test(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** Languages used by fenced code blocks in `src`. */
export function fenceLanguages(src: string): string[] {
  const langs = new Set<string>();
  for (const t of md.parse(src, {}))
    if (t.type === "fence") {
      const lang = t.info.trim().split(/\s+/)[0];
      if (lang && lang !== "mermaid") langs.add(lang);
    }
  return [...langs];
}

/** Load shiki and the fence grammars so renderMarkdown can highlight synchronously. */
export async function prepareMarkdown(src: string): Promise<void> {
  await loadLanguages(fenceLanguages(src));
}

/**
 * Markdown to .oa-doc HTML. Raw HTML is escaped and unsafe URLs are dropped.
 * Fences are highlighted when prepareMarkdown has loaded their grammar.
 */
export function renderMarkdown(src: string): string {
  return `<article class="oa-doc">${md.render(src, {} satisfies Env)}</article>`;
}
