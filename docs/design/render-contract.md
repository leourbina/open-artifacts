# Render markup contract (D5 → B11)

`packages/render/src/theme.css` styles the HTML that B11's renderers emit inside the content-host sandbox. The CSS is self-contained: it inlines the Studio tokens and loads nothing from the dashboard. This file is the contract between them. If you change the markup, update this file and the theme together.

Imports:

```ts
import "@oa/render/theme.css";                // or inline it into the renderer page
import { shikiThemes } from "@oa/render/shiki-themes"; // { light, dark }: ThemeRegistration
```

## Theme

- The theme comes from the **nearest** `data-theme="light|dark"` on `<html>`, on any ancestor, or on the container itself. The shell sets it on `<html>` from the viewer's preference. Without one, `prefers-color-scheme` decides.
  - Known limit: more than two nested `data-theme` levels can resolve wrong. This doesn't matter as long as only `<html>` carries the attribute.
- **Print** is always light. It wraps code, drops shadows and chrome, and appends the URL after each external link.

## Markdown (`.oa-doc`)

```html
<article class="oa-doc"> …markdown-it output… </article>
```

- Reading width ≤ 72ch (70ch). Base font size 16px.
- **Code fences** are wrapped so the label and copy button stay put while the code scrolls:

  ```html
  <div class="oa-codeblock" data-lang="ts">
    <!-- shiki: codeToHtml(src, { lang, themes: shikiThemes }) -->
    <pre class="shiki shiki-themes …">…</pre>
    <button class="oa-copy" type="button" aria-label="Copy code">…</button> <!-- optional -->
  </div>
  ```

  The copy button shows on hover and `:focus-within`, and always under `(hover: none)`.
- **Mermaid:** `<pre class="mermaid">` or `<figure class="oa-mermaid">`. Suggested Mermaid `themeVariables` (theme `base`):

  | Variable | light | dark |
  |---|---|---|
  | background | `#ffffff` | `#1c1f23` |
  | primaryColor | `#f6f7f9` | `#212429` |
  | primaryBorderColor | `#848b95` | `#676e78` |
  | primaryTextColor | `#15181c` | `#e9ebee` |
  | lineColor | `#5f6670` | `#9097a1` |
  | secondaryColor | `#e7edfc` | `#1f2a4a` |
  | tertiaryColor / edgeLabelBackground | `#ffffff` | `#1c1f23` |

  Use `fontFamily: "Geist, ui-sans-serif, sans-serif"` and `fontSize: "14px"`.
- **Task lists:** both tight (`li > input[type=checkbox]`) and loose (`li > p > input[type=checkbox]`) work.
- Footnotes use markdown-it-footnote's default markup. Tables are content-width, GitHub style.

## Code view (`.oa-code`)

```html
<div class="oa-code" data-wrap="false">
  <header class="oa-code-header">
    <span class="oa-code-name">backfill.py</span>
    <span class="oa-code-lang">Python</span>
    <div class="oa-code-actions">
      <button class="oa-wrap" type="button" aria-pressed="false">Wrap</button>
      <button class="oa-copy" type="button" aria-label="Copy code">…</button>
    </div>
  </header>
  <!-- shiki pre; each line is <span class="line"> (line numbers come from a CSS counter on .line) -->
</div>
```

`data-wrap="true"` wraps long lines.

## PDF (`.oa-pdf`)

```html
<div class="oa-pdf">
  <div class="oa-pdf-toolbar">
    <div class="oa-pdf-group">…page n / N…</div>
    <span class="oa-pdf-sep"></span>
    <div class="oa-pdf-zoom">…</div>
  </div>
  <div class="pdfViewer"> <!-- or .oa-pdf-pages -->
    <div class="page" style="--scale-factor: 1.25">  <!-- pdf.js 4; pdf.js 5 uses --total-scale-factor -->
      <canvas>…</canvas>
      <div class="textLayer">…</div>
    </div>
  </div>
</div>
```

The text-layer rules mirror pdf.js's `pdf_viewer.css`. Spans use `--font-height` and `--scale-x`, and the text is transparent and selectable.

## Never

`theme.css` applies only to `.oa-doc`, `.oa-code` and `.oa-pdf`. Never load it into **HTML-format** artifacts. Those render as authored.
