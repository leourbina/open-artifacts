import type { HighlighterCore, LanguageRegistration } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { shikiThemes } from "./shiki-themes";

type Loader = () => Promise<{ default: LanguageRegistration[] }>;

/** Each grammar is its own lazy chunk; nothing loads until a block needs it. */
const LOADERS: Record<string, Loader> = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  elixir: () => import("@shikijs/langs/elixir"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  hcl: () => import("@shikijs/langs/hcl"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  makefile: () => import("@shikijs/langs/makefile"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  shellsession: () => import("@shikijs/langs/shellsession"),
  sql: () => import("@shikijs/langs/sql"),
  svelte: () => import("@shikijs/langs/svelte"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  zig: () => import("@shikijs/langs/zig"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  py: "python",
  python3: "python",
  golang: "go",
  rs: "rust",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellsession",
  yml: "yaml",
  md: "markdown",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  gql: "graphql",
  docker: "dockerfile",
  make: "makefile",
  mk: "makefile",
  tf: "hcl",
  terraform: "hcl",
  ex: "elixir",
  exs: "elixir",
  svg: "xml",
  htm: "html",
  patch: "diff",
  toml: "toml",
};

/** Canonical grammar id for a fence/file language, or null when unsupported. */
export function resolveLang(lang: string): string | null {
  const l = lang.trim().toLowerCase();
  const id = ALIASES[l] ?? l;
  return id in LOADERS ? id : null;
}

const DISPLAY: Record<string, string> = {
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  graphql: "GraphQL",
  hcl: "HCL",
  html: "HTML",
  ini: "INI",
  javascript: "JavaScript",
  json: "JSON",
  jsonc: "JSONC",
  jsx: "JSX",
  mdx: "MDX",
  php: "PHP",
  scss: "SCSS",
  shellscript: "Shell",
  shellsession: "Shell",
  sql: "SQL",
  toml: "TOML",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

export function displayLang(lang: string): string {
  const id = resolveLang(lang);
  if (!id) return lang ? lang : "Text";
  return DISPLAY[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

let highlighter: HighlighterCore | null = null;
let creating: Promise<HighlighterCore> | null = null;
const loading = new Map<string, Promise<void>>();

async function getHighlighter(): Promise<HighlighterCore> {
  creating ??= createHighlighterCore({
    themes: [shikiThemes.light, shikiThemes.dark],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((h) => {
    highlighter = h;
    return h;
  });
  return creating;
}

/** Load the highlighter and the given languages; unknown names are skipped. */
export async function loadLanguages(langs: Iterable<string>): Promise<void> {
  const h = await getHighlighter();
  const ids = new Set<string>();
  for (const l of langs) {
    const id = resolveLang(l);
    if (id) ids.add(id);
  }
  await Promise.all(
    [...ids].map((id) => {
      let p = loading.get(id);
      if (!p) {
        const loader = LOADERS[id] as Loader;
        p = loader().then((m) => h.loadLanguage(...m.default));
        loading.set(id, p);
      }
      return p.catch(() => undefined);
    }),
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Unhighlighted fallback with the same .line structure as shiki. */
export function plainHtml(src: string): string {
  const lines = src.replace(/\n$/, "").split("\n");
  const body = lines
    .map((l) => `<span class="line">${escapeHtml(l)}</span>`)
    .join("\n");
  return `<pre class="shiki" tabindex="0"><code>${body}</code></pre>`;
}

/** Synchronous highlight: uses shiki when the grammar is already loaded, else plainHtml. */
export function highlightSync(src: string, lang: string): string {
  const id = resolveLang(lang);
  const code = src.replace(/\n$/, "");
  if (!highlighter || !id || !highlighter.getLoadedLanguages().includes(id))
    return plainHtml(code);
  try {
    return highlighter.codeToHtml(code, {
      lang: id,
      // Long lines are quadratic in the tokenizer; past this they stay plain.
      tokenizeMaxLineLength: 1000,
      themes: {
        light: shikiThemes.light.name as string,
        dark: shikiThemes.dark.name as string,
      },
    });
  } catch {
    return plainHtml(code);
  }
}
