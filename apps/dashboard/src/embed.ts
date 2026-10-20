import type { RouterHistory } from "@tanstack/react-router";

/**
 * Embed mode: this document is framed by another page. Decided here, once at
 * boot, by the shell itself; never from a meta, param or header (the framing
 * page controls those). Fail-closed: a throw means framed. In embed mode the
 * shell runs anonymously (no credentials, no signed-in UI or viewer identity),
 * stays on the /a/<id>/full it booted on, and opens every link in a new tab.
 */
export function detectEmbed(w: Pick<Window, "self" | "top"> = window): boolean {
  try {
    return w.self !== w.top;
  } catch {
    return true; // A cross-origin parent throws on access.
  }
}

let embed = typeof window !== "undefined" && detectEmbed();
export const isEmbed = () => embed;
/** Tests only. */
export const setEmbedForTests = (v: boolean) => {
  embed = v;
};

/** Sent on every API request and the data socket in embed mode; a downgrade hint only. */
export const EMBED_HEADER = "X-OA-Embed";

const FULL_RE = /^\/a\/[^/]+\/full\/?$/i;
/** The only route a framed shell renders. */
export const isFullPath = (pathname: string) => FULL_RE.test(pathname);

/** Opens `href` in a new tab with no opener; only http(s) URLs. */
export function openInNewTab(href: string) {
  let u: URL;
  try {
    u = new URL(href, location.href);
  } catch {
    return;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return;
  window.open(u.href, "_blank", "noopener");
}

/**
 * Pins the router and the window's history to `pathname`: client-side
 * navigation elsewhere (router, history API, back/forward) is dropped; link
 * clicks open a new tab instead; form submissions are dropped.
 */
export function lockToPath(
  router: { history: RouterHistory },
  pathname: string,
  w: Window = window,
) {
  const same = (next: string) => {
    try {
      return new URL(next, w.location.href).pathname === pathname;
    } catch {
      return false;
    }
  };
  const unblock = router.history.block({
    blockerFn: ({ nextLocation }) => nextLocation.pathname !== pathname,
    enableBeforeUnload: false,
  });
  const h = w.history;
  const push = h.pushState;
  const replace = h.replaceState;
  h.pushState = (data, unused, url) => {
    if (url == null || same(String(url))) push.call(h, data, unused, url);
  };
  h.replaceState = (data, unused, url) => {
    if (url == null || same(String(url))) replace.call(h, data, unused, url);
  };
  // Capture on the document runs before React's root listener, so no
  // in-app handler (router Link included) sees a guarded click.
  const onClick = (e: MouseEvent) => {
    const t = e.target as Element | null;
    const a = t?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    // Already a new tab with no opener: let it through (and its own handler).
    if (a.target === "_blank" && /\bnoopener\b|\bnoreferrer\b/.test(a.rel))
      return;
    e.preventDefault();
    e.stopPropagation();
    openInNewTab(a.href);
  };
  const onSubmit = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  w.document.addEventListener("click", onClick, true);
  w.document.addEventListener("submit", onSubmit, true);
  return () => {
    unblock();
    h.pushState = push;
    h.replaceState = replace;
    w.document.removeEventListener("click", onClick, true);
    w.document.removeEventListener("submit", onSubmit, true);
  };
}
