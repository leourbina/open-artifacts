# Demo artifacts

Real-time demos for demo.open-artifacts.com, built only on `window.openArtifacts`.

- `artifacts/<slug>/index.html`: the artifact source, one self-contained file each.
- `seed/<slug>.json`: what the nightly reset writes. `collections` maps a collection
  name to `{ docId: data }`; the reset deletes every doc in a listed collection and
  writes the seed docs. Collections named by UTC day (`name-YYYYMMDD`) need no seed:
  the reset only prunes days older than yesterday.
- `artifacts.json`: published artifact ids per instance, used by the landing build.
- `artifacts/gallery/`: the front door. Signed-out visitors to the demo root land on it
  (`PUBLIC_HOME`). It lists the demos from one `DEMOS` array in the page; add a demo there
  once it is approved.

## Identity

Until the server provides an anonymous id (`anonId`), anonymous viewers get a random
id per tab (the sandboxed frame has no persistent storage), so a reload counts as a
new browser. Each artifact already prefers `viewer.get().anonId` or
`openArtifacts.anonId`, and ignores writes stamped `updatedBy: "anon:<id>"` that do
not belong to the doc's owner (the poll). Tic-tac-toe uses the id only for its seat labels.

## Seeds

| Artifact | Seed |
| --- | --- |
| poll | None: votes live in `votes-YYYYMMDD` (UTC). |
| tictactoe | `game/game` back to an empty board with both seats open. Clients apply a write only if it is one claim, leave, move or start over from the last state they accepted; seats are first come, first served, and the id is only used for the seat labels. |
| chess | `table/table` back to game `g0` with both seats open, and every doc in `moves` deleted. Moves are append-only docs (`moves/<g>-<nnn>`, UCI); every window replays them with the inline rules engine and drops any move that is not legal from the last accepted position, in sequence. Seats are first come, first served and free 5 minutes after the last move. |

## Gallery placeholders

The gallery cannot know artifact ids or the app origin ahead of time, so the source holds
placeholders that the publish script fills before it uploads the page:

| Placeholder | Replaced with | Source |
| --- | --- | --- |
| `{{id:<slug>}}` | the bare artifact id of `artifacts/<slug>`, for example `CkyAe3uSYRnYthKz` | `ops/demo/ids.json` (`{ "<slug>": "<id>" }`) |
| `{{origin}}` | the app origin with no trailing slash, for example `https://demo.open-artifacts.com` | the instance being published to |

Publish the other demos first, write their ids to `ids.json`, then publish the gallery.
The page links to `<origin>/a/<id>`. A card whose id is still a placeholder (or not a valid
id) is left out, so a demo that is not published yet never shows a dead link. If `{{origin}}`
is left unfilled the page falls back to `location.ancestorOrigins` (Chromium and Safari only),
then to a relative `/a/<id>`, which resolves against the content host and does not work.
This needs Platform's publish script to support it.

Navigation out of the artifact frame: the viewer sandbox allows popups that escape the
sandbox (`allow-popups-to-escape-sandbox`) but no top navigation. So every gallery link opens
a new tab (`target="_blank" rel="noopener"`), and "Open in two windows" takes two clicks,
one popup each, because browsers allow one popup per click.
