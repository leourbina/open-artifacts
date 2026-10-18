export const FORMATS = ["html", "markdown", "code", "pdf"] as const;
export type Format = (typeof FORMATS)[number];

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
function ext(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

export function inferFormat(entry: string): Format {
  switch (ext(entry)) {
    case "html":
    case "htm":
      return "html";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "pdf":
      return "pdf";
    default:
      return "code";
  }
}

const LANGUAGES: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  py: "py",
  go: "go",
  rs: "rs",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  sql: "sql",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  md: "md",
  markdown: "md",
  mdx: "mdx",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  rb: "rb",
  java: "java",
  kt: "kt",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "cs",
  php: "php",
  lua: "lua",
  r: "r",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  gql: "graphql",
  ini: "ini",
  diff: "diff",
  patch: "diff",
  tf: "hcl",
  hcl: "hcl",
  ex: "elixir",
  exs: "elixir",
  zig: "zig",
  dockerfile: "dockerfile",
  makefile: "makefile",
  mk: "makefile",
};
const LANGUAGE_BY_NAME: Record<string, string> = {
  makefile: "makefile",
  dockerfile: "dockerfile",
};

export function inferLanguage(path: string): string {
  const name = basename(path).toLowerCase();
  const byName = LANGUAGE_BY_NAME[name];
  if (byName) return byName;
  return LANGUAGES[ext(path)] ?? "text";
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  mdx: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
  zip: "application/zip",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  jsx: "text/javascript; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[ext(path)] ?? "application/octet-stream";
}

export function isTextContentType(ct: string): boolean {
  const t = (ct.split(";")[0] ?? "").trim().toLowerCase();
  if (t.startsWith("text/")) return true;
  return (
    t === "application/json" ||
    t === "application/xml" ||
    t === "application/javascript" ||
    t === "image/svg+xml" ||
    t.endsWith("+json") ||
    t.endsWith("+xml")
  );
}
