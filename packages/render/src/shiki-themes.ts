import type { ThemeRegistration } from "shiki";

/*
 * Reading themes for shiki, aligned with the Studio tokens (design/DIRECTION.md).
 * Neutral grays carry most code; the accent marks keywords and a few muted
 * hues separate strings, numbers, functions and types. The background is
 * --oa-surface-2, the code background in theme.css, and every foreground
 * reaches 4.5:1 on it (test/theme.test.ts).
 */

interface Palette {
  bg: string;
  fg: string;
  comment: string;
  punctuation: string;
  keyword: string;
  string: string;
  number: string;
  func: string;
  type: string;
  tag: string;
  selection: string;
  lineNumber: string;
}

const light: Palette = {
  bg: "#f6f7f9",
  fg: "#15181c",
  comment: "#5f6670",
  punctuation: "#454c56",
  keyword: "#1d45b8",
  string: "#157a3a",
  number: "#8a5a00",
  func: "#6a3fa5",
  type: "#0e6b73",
  tag: "#b02a1a",
  selection: "#e7edfc",
  lineNumber: "#5f6670",
};

const dark: Palette = {
  bg: "#212429",
  fg: "#e9ebee",
  comment: "#9097a1",
  punctuation: "#b7bdc6",
  keyword: "#a3b8ff",
  string: "#6fd08f",
  number: "#e7b44f",
  func: "#c8a8ff",
  type: "#62c6cc",
  tag: "#ff8f7d",
  selection: "#1f2a4a",
  lineNumber: "#9097a1",
};

function theme(
  name: string,
  type: "light" | "dark",
  p: Palette,
): ThemeRegistration {
  return {
    name,
    type,
    colors: {
      "editor.background": p.bg,
      "editor.foreground": p.fg,
      "editor.selectionBackground": p.selection,
      "editorLineNumber.foreground": p.lineNumber,
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: { foreground: p.comment },
      },
      {
        scope: [
          "punctuation",
          "meta.brace",
          "keyword.operator",
          "punctuation.definition.tag",
        ],
        settings: { foreground: p.punctuation },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.control",
          "variable.language",
        ],
        settings: { foreground: p.keyword },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "punctuation.definition.string",
          "markup.inline.raw",
        ],
        settings: { foreground: p.string },
      },
      {
        scope: [
          "constant",
          "constant.numeric",
          "constant.language",
          "constant.character.escape",
          "support.constant",
        ],
        settings: { foreground: p.number },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call entity.name.function",
        ],
        settings: { foreground: p.func },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "support.type",
          "support.class",
          "entity.other.inherited-class",
        ],
        settings: { foreground: p.type },
      },
      {
        scope: [
          "entity.name.tag",
          "entity.other.attribute-name",
          "invalid",
          "markup.deleted",
        ],
        settings: { foreground: p.tag },
      },
      {
        scope: [
          "variable",
          "variable.other",
          "variable.parameter",
          "meta.object-literal.key",
          "support.variable.property",
        ],
        settings: { foreground: p.fg },
      },
      {
        scope: ["markup.heading", "entity.name.section"],
        settings: { foreground: p.keyword, fontStyle: "bold" },
      },
      {
        scope: ["markup.inserted"],
        settings: { foreground: p.string },
      },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    ],
  };
}

export const shikiThemes: {
  light: ThemeRegistration;
  dark: ThemeRegistration;
} = {
  light: theme("oa-light", "light", light),
  dark: theme("oa-dark", "dark", dark),
};
