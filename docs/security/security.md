# Security model notes

## Links and navigation from artifacts

The content host sends `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`, and the viewer iframe sets the same `sandbox` tokens. `allow-same-origin` and every `allow-top-navigation*` token are never set.

- **New tabs: allowed.** An artifact may open links in a new tab (`target="_blank"`, ideally with `rel="noopener"`). With `allow-popups-to-escape-sandbox` that tab is a normal, unsandboxed page on the link's own origin. A popup to an external site carries none of our credentials (the artifact runs in an opaque origin and the content host never sets cookies). A popup to the app host is a top-level GET, so it sends the Lax session cookie like any link and lands on our own pages, which `Cross-Origin-Opener-Policy: same-origin` isolates from the opener.
- **The viewer page: never.** Without `allow-top-navigation*`, an artifact cannot navigate the viewer (top) page.
- **Top-level loads of content URLs:** a content URL opened directly as a top-level page redirects to the viewer (#294), so an artifact never renders outside its sandboxed frame.
- **`window.opener` renavigation:** a page opened from an artifact could try to drive its opener. The per-load bridge nonce (#306) means a renavigated or foreign frame cannot speak to the viewer's bridge.
