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

Data-subscribe sockets split the same way: 200 per DO for signed-in viewers (20 per user), 100 for anonymous viewers (8 per anonymous actor, an IPv4 address or an IPv6 /56, also the `sub:ip:` RL_ANON key). Anonymous floods from many addresses fill only the anonymous pool, so members keep live data. A data socket with no actor is refused (400).

## Direct sign-in (hosted M1, P2)

Direct sign-in replaces Cloudflare Access with Google (one multi-tenant client) and emailed codes. The red line is that no one signs in to another customer's install.

| Threat | Mitigation | Residual |
|---|---|---|
| Broker compromise (hosted) | The broker returns Google's raw ID token. Each install verifies the signature, `aud`, its own nonce and `hd` itself. The registry holds Ed25519 public keys only. | The broker holds the client secret and the callback, so it can obtain tokens only for victims who click a crafted link, for a flow whose state cookie the attacker controls. |
| Token for another tenant | `hd` must be exactly one of the install's `AUTH_DOMAINS`. The email domain is never consulted. | None known. |
| Provider mix-up | The state cookie names its provider; a callback for another provider is refused before any token call. | None known. |
| Recycled or spoofed identity | Users are keyed by `identities (google, sub)`. Email links an unlinked active row at most once; another `sub` gets `identity_conflict`; removed and suspended rows are never linked. | An admin resets the link. |
| Code guessing | 8 digits, 5 atomic tries per request, a per-IP failure cap (30 an hour), per-address request caps, a 10 minute TTL. | At most 150 guesses per address per hour, each emailing the victim. |
| Victim lockout | Rows are per request and failures per request and per IP, so another person's requests can't cancel a pending code. | A distributed attacker can reach the per-address request ceiling (alerted). |
| Address enumeration | The same 202 for every address. Delivery runs after the response. Verify runs the same statements with or without a code, and its wording comes from the browser's own cookie. | None known. |
| Email quota exhaustion | The code pool is separate from invites and is spent only on real sends. There is a per-IP daily cap and Turnstile. | Requests for guests count against the per-IP quota. |
| Login CSRF | `__Host-` Lax cookies, `X-OA-Request`, and `Sec-Fetch-Site: same-origin` or an exact `Origin`. | None known. |
| Guests writing | A capped caller (a guest under direct sign-in, or any code session outside the domains) is read-only on the whole API, refused before any route. | None known. |
| Test hooks in production | Hooks require a build flag release builds never set, plus `TEST_HOOKS=1` and a 32+ character key. Otherwise every path is a 404. | Operator error on a staging install. |
| Stale sessions | Sessions carry the user's epoch (a role change or link reset ends them) and their tenant. | Suspension in the Workspace takes effect with P3's directory sync. |

The cross-tenant catalog (`apps/server/test/xt/signin-negative.ts`) runs locally in CI and live against two staging installs before every release (`pnpm --filter @oa/server xt:live`, which sets `XT_LIVE=1`). The live run refuses origins outside the staging allowlist (https, exactly one label under `open-artifacts-staging.app` or `open-artifacts-staging.page`) and requires `/healthz` `testHooks: true` and distinct `installId`s on both installs before it reads any credential file. Both installs run with `TEST_DOMAIN=xt-guest.example`, the only domain the catalog uses. Credential files must be regular files, owned by the runner, mode 0600 or stricter, and not symlinks. Broker and tenant cases: #423.
