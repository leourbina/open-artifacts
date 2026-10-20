# Bridge per-load nonce

The artifact frame is sandboxed without `allow-same-origin`, so every document
in it has an opaque origin and the shell sees `origin === "null"` for all of
them. The `source === iframe.contentWindow` check identifies the frame, not the
document in it. Without more, any document the frame is renavigated to (by the
artifact, or by anything allowed to navigate it) would inherit the bridge and
the viewer's capabilities for that artifact.

## Mechanism

- **Mint.** `loadArtifactFrame` (`apps/dashboard/src/viewer/frame.ts`) is the
  only way to point an artifact iframe at content. Each call mints 16 random
  bytes (`crypto.getRandomValues`), base64url without padding (22 characters),
  and sets `src` to `<contentUrl>#oa=<nonce>` (`&oa=` if the URL already has a
  fragment). Every intentional load (first load, refreshed content URL, Reload)
  gets a new nonce. The JSX `src` prop is never used on artifact frames.
- **Read and strip.** The runtime (`shellNonce` in `packages/shared/src/nonce.ts`)
  reads `oa` from `location.hash` once, before any artifact script runs, caches
  it on the window, and removes it with `history.replaceState` (keeping the
  path, query and the rest of the fragment). If `replaceState` throws, the hash
  is left in place.
- **Send.** Every artifact to shell message (`hello`, `call`, `pdf.text`,
  `thumb.ready`, `resize`) carries `nonce`.
- **Check.** The dashboard bridge drops any message whose `nonce` is not the
  current load's, before parsing its type.
- **Renavigation.** The bridge expects exactly one `load` per intentional load.
  Any other `load` means the frame navigated somewhere the shell didn't send it;
  the bridge disposes itself (aborts in-flight calls, closes subscriptions, stops
  answering). The frame stays up without a bridge until Reload.

## Why the fragment

The fragment is never sent to a server and never appears in `Referer`. A
cross-origin document can't read another frame's `location`, so only the
document loaded with the nonce learns it.

## Pre-load window

Between the `src` assignment and its `load` event, a different document in the
frame can post. It is dropped unless it carries the current nonce, which only the
intended load's document has (covered by
`apps/dashboard/test/bridge-nonce.test.ts`). The artifact itself knows its
nonce; if it navigates its own frame to a URL carrying `#oa=<nonce>`, that is the
artifact acting with capabilities it already has, not an escalation.

## Limits

- A multi-page artifact's own in-frame navigation (a link to another page of the
  same artifact) loses the bridge until Reload.
- The runtime and the dashboard bridge ship together: a runtime without the
  nonce is ignored by the new bridge.
