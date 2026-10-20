# Demo artifacts

Real-time demos for demo.open-artifacts.com, built only on `window.openArtifacts`.

- `artifacts/<slug>/index.html`: the artifact source, one self-contained file each.
- `seed/<slug>.json`: what the nightly reset writes. `collections` maps a collection
  name to `{ docId: data }`; the reset deletes every doc in a listed collection and
  writes the seed docs. Collections named by UTC day (`name-YYYYMMDD`) need no seed:
  the reset only prunes days older than yesterday.
- `artifacts.json`: published artifact ids per instance, used by the landing build.

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
