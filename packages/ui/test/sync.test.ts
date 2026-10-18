import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tokens } from "../src/index";

type Rule = { prelude: string; body: string; children: Rule[] };

const css = readFileSync(
  new URL("../src/tokens/tokens.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits CSS into top-level rules (statements like @import are skipped). */
function parse(src: string): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    const semi = src.indexOf(";", i);
    if (open < 0) break;
    if (semi >= 0 && semi < open) {
      i = semi + 1;
      continue;
    }
    let depth = 1;
    let j = open + 1;
    while (depth > 0 && j < src.length) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    if (depth > 0) throw new Error("unbalanced braces");
    const body = src.slice(open + 1, j - 1);
    rules.push({
      prelude: src.slice(i, open).trim().replace(/\s+/g, " "),
      body,
      children: body.includes("{") ? parse(body) : [],
    });
    i = j;
  }
  return rules;
}

/** Collects --oa-* declarations; a duplicate within one block throws. */
function declarations(body: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const [, name, value] of body.matchAll(
    /--oa-([\w-]+)\s*:\s*([^;]+)(?:;|$)/g,
  )) {
    if (props.has(name as string)) throw new Error(`duplicate token: ${name}`);
    props.set(name as string, (value as string).trim().toLowerCase());
  }
  return props;
}

const LIGHT = ":root";
const DARK_ATTR = ':root[data-theme="dark"]';
const DARK_MEDIA = "@media (prefers-color-scheme: dark)";
const DARK_MEDIA_RULE = ':root:not([data-theme="light"])';

const light = new Map<string, string>();
const darkAttr = new Map<string, string>();
const darkMedia = new Map<string, string>();
for (const rule of parse(css)) {
  if (rule.prelude === LIGHT || rule.prelude === DARK_ATTR) {
    const target = rule.prelude === LIGHT ? light : darkAttr;
    for (const [k, v] of declarations(rule.body)) target.set(k, v);
  } else if (rule.prelude === DARK_MEDIA) {
    const [inner, ...rest] = rule.children;
    if (inner?.prelude !== DARK_MEDIA_RULE || rest.length > 0) {
      throw new Error(`${DARK_MEDIA} must hold only ${DARK_MEDIA_RULE}`);
    }
    for (const [k, v] of declarations(inner.body)) darkMedia.set(k, v);
  } else {
    throw new Error(`unexpected rule: ${rule.prelude}`);
  }
}

const isColor = (v: string) => /^#[0-9a-f]{6}$/.test(v);
const colorsOf = (props: Map<string, string>) =>
  Object.fromEntries([...props].filter(([, v]) => isColor(v)));
const expected = (theme: "light" | "dark") =>
  Object.fromEntries(
    Object.entries(tokens).map(([k, v]) => [k, v[theme].toLowerCase()]),
  );

describe("tokens.css matches the TS export", () => {
  it("light colors", () => {
    expect(colorsOf(light)).toEqual(expected("light"));
  });

  it.each([
    ["prefers-color-scheme", darkMedia],
    ["data-theme", darkAttr],
  ])("dark colors (%s)", (_, dark) => {
    expect(colorsOf(dark)).toEqual(expected("dark"));
  });

  it("both dark blocks are identical", () => {
    expect(darkMedia.size).toBeGreaterThan(0);
    expect(Object.fromEntries(darkMedia)).toEqual(Object.fromEntries(darkAttr));
  });
});
