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
| pixels | None: pixels live in `canvas-YYYYMMDD` (UTC), one doc per row (`r00`..`r31`), one key per pixel (`c0`..`c31`, a palette index). A pixel is `update(row, { cN })`, a shallow merge, so painters in the same row never clobber each other. Any visitor can paint any pixel; the 4 second cooldown is per browser. |
| dashboard | `stats` emptied. Only Platform's demo-ops Worker writes, once a minute, with its token (`allowAnonymousWrites: false`): `stats/today` = `{ day, updatedAt, votes, gamesInProgress: { tictactoe, chess }, moves: { tictactoe, chess }, pixels, countries, pins, truncated? }` and `stats/hourly-YYYYMMDD` = `{ h: [24 writes per UTC hour] }`. A metric named in `truncated` is a lower bound and shows as "400+". The page only reads; it shows a stale badge when `updatedAt` is over 3 minutes old. |

## Fake stats feed

`tools/fake-stats.mjs` stands in for the demo-ops Worker when testing the dashboard against a
local instance. It writes `stats/today` and `stats/hourly-YYYYMMDD` through the REST data API
every few seconds, with counts that grow like a busy demo:

```sh
node ops/demo/tools/fake-stats.mjs --origin http://localhost:8787 --artifact <id> --token <PAT>
```

`--every <s>` sets the interval (default 3), `--truncate pixels,moves` marks metrics as lower
bounds, `--age 240` backdates `updatedAt` to show the stale state, and `--once` writes one tick
and exits. The token is a PAT of the artifact's owner (or set `OA_TOKEN`).

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
