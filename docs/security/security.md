# Security model notes

## Links and navigation from artifacts

The content host sends `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`, and the viewer iframe sets the same `sandbox` tokens. `allow-same-origin` and every `allow-top-navigation*` token are never set.

- **New tabs: allowed.** An artifact may open links in a new tab (`target="_blank"`, ideally with `rel="noopener"`). With `allow-popups-to-escape-sandbox` that tab is a normal, unsandboxed page on the link's own origin. A popup to an external site carries none of our credentials (the artifact runs in an opaque origin and the content host never sets cookies). A popup to the app host is a top-level GET, so it sends the Lax session cookie like any link and lands on our own pages, which `Cross-Origin-Opener-Policy: same-origin` isolates from the opener.
- **The viewer page: never.** Without `allow-top-navigation*`, an artifact cannot navigate the viewer (top) page.
- **Top-level loads of content URLs:** a content URL opened directly as a top-level page redirects to the viewer (#294), so an artifact never renders outside its sandboxed frame.
- **`window.opener` renavigation:** a page opened from an artifact could try to drive its opener. The per-load bridge nonce (#306) means a renavigated or foreign frame cannot speak to the viewer's bridge.

## Live sockets and access revocation

Open live sockets (data subscribe and the `R.events` version feed) are authorized when they connect. Deletes, visibility and capability changes, and revoked shares close them at once (`gone`, then 4403 on `R.events`). Removing a member closes only their sockets on artifacts shared with them by email. Their sockets on team-visible artifacts stay open until the next TTL rotation (4408), and the reconnect is refused. So **access revocation reaches open live sockets within at most 10 minutes (`LIMITS.signedUrlTtlSec`); deletes and visibility changes are immediate.** Closing by actor on every team artifact's DO would cost one RPC per artifact for each removal.

`R.events` sockets have their own per-DO budgets, apart from data sockets: 200 for signed-in viewers, 100 for anonymous viewers, and 3 per anonymous actor (an IPv4 address or an IPv6 /56). Anonymous sockets can't starve live data or members.
