---
title: Runtime API
description: Let HTML artifacts save and read data with window.openArtifacts.
order: 4
---

An HTML artifact can keep data with `window.openArtifacts`. Polls, trackers, and checklists all work this way. The data belongs to the artifact, not a version, so a new version sees the same data.

## Capabilities

An artifact declares what it uses when it's published, for example `capabilities: { db: true, viewer: true }`. Calls to anything it didn't declare are rejected.

| Capability | Gives the page |
|---|---|
| `db` | Shared data that every viewer sees |
| `viewer` | Who is viewing |
| `storage` | Private data for each viewer |

## Shared data: `db`

`db.collection(name)` returns a collection with:

- `get(id)`, `list()`, and `query(filter)` to read
- `set(id, doc)`, `update(id, patch)`, and `delete(id)` to write
- `subscribe(callback)` for live updates when anyone changes the collection

```js
const votes = openArtifacts.db.collection("votes");
await votes.set(crypto.randomUUID(), { option: "Lisbon" });
votes.subscribe(async () => render(await votes.list()));
```

## The viewer: `viewer`

`viewer.get()` returns `{ email, name }`, or `null` for an anonymous viewer of a public artifact.

## Per-viewer data: `storage`

`storage` keeps documents keyed to the current viewer, such as which boxes they ticked, with `get`, `set`, `delete`, and `list`.

## Who can write

- Signed-in viewers who can see the artifact can read and write.
- Anonymous viewers of a public artifact can read. They can write only if the publisher turned on `allowAnonymousWrites`, and those writes are rate-limited per IP address.

## Limits

| Limit | Default |
|---|---|
| Document size | 1 MB |
| Data per artifact | 50 MB |
| Writes per viewer | 100 per minute |
| Anonymous writes per IP | 30 per minute |

## How it works

The artifact runs in a sandboxed iframe with no credentials. Each call goes by `postMessage` to the viewer shell around it, which checks the call and makes it with the viewer's session. Raw view drops the shell, so the runtime API isn't available there.
