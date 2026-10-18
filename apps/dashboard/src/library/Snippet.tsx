import { SNIPPET_MARK } from "@oa/shared";

const { open, close } = SNIPPET_MARK;
const split = new RegExp(`${open}([^${close}]*)${close}`);
const stray = new RegExp(`[${open}${close}]`, "g");

/** Marked runs become <mark>; everything else renders as text. */
export function Snippet({ text }: { text: string }) {
  // Keys are cumulative text offsets, stable for a given snippet.
  let offset = 0;
  return (
    <>
      {text.split(split).map((part, i) => {
        const s = part.replace(stray, "");
        const key = offset;
        offset += part.length + 1;
        return i % 2 ? <mark key={key}>{s}</mark> : <span key={key}>{s}</span>;
      })}
    </>
  );
}
