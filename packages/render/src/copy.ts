/** Copy text: the async clipboard API (often blocked in the sandbox), else execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** One delegated handler for every .oa-copy and .oa-wrap button. */
export function wireCodeButtons(root: HTMLElement | Document = document): void {
  root.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    const copy = target?.closest?.(".oa-copy");
    if (copy) {
      const box = copy.closest(".oa-codeblock, .oa-code");
      const code = box?.querySelector("pre code") ?? box?.querySelector("pre");
      if (!code) return;
      void copyText(code.textContent ?? "").then((ok) => {
        copy.setAttribute("data-copied", ok ? "true" : "false");
        copy.textContent = ok ? "Copied" : "Copy failed";
        setTimeout(() => {
          copy.removeAttribute("data-copied");
          copy.textContent = "Copy";
        }, 1500);
      });
      return;
    }
    const wrap = target?.closest?.(".oa-wrap");
    const view = wrap?.closest(".oa-code");
    if (wrap && view) {
      const on = view.getAttribute("data-wrap") !== "true";
      view.setAttribute("data-wrap", String(on));
      wrap.setAttribute("aria-pressed", String(on));
    }
  });
}
