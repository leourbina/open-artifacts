import {
  displayLang,
  escapeHtml,
  highlightSync,
  loadLanguages,
  plainHtml,
} from "./highlight";

/** Above this size shiki is too slow in the browser; render plain numbered lines. */
const HIGHLIGHT_MAX_CHARS = 512 * 1024;

const COPY =
  '<button class="oa-copy" type="button" aria-label="Copy code">Copy</button>';

/** The .oa-code view (D5 contract): header with name, language, wrap and copy; shiki body. */
export async function renderCode(
  src: string,
  language: string,
  name = "",
): Promise<string> {
  let body: string;
  if (src.length > HIGHLIGHT_MAX_CHARS) body = plainHtml(src);
  else {
    await loadLanguages([language]);
    body = highlightSync(src, language);
  }
  return `<div class="oa-code" data-wrap="false">
<header class="oa-code-header">
<span class="oa-code-name">${escapeHtml(name)}</span>
<span class="oa-code-lang">${escapeHtml(displayLang(language))}</span>
<div class="oa-code-actions">
<button class="oa-wrap" type="button" aria-pressed="false">Wrap</button>
${COPY}
</div>
</header>
${body}
</div>`;
}

export const COPY_BUTTON = COPY;
