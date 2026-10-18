---
title: MCP tools
description: The tools every instance's MCP server exposes, and what each one takes.
order: 3
---

Tool inputs are JSON Schema. Each tool returns plain text plus structured output. Calls act as the signed-in user (or the token's owner), and an artifact you can't access is reported as not found.

## Publishing

`publish_artifact` creates an artifact, or publishes a new version when you pass `id`.

| Field | Notes |
|---|---|
| `title` | Required. |
| `description` | Optional. |
| `format` | `html`, `markdown`, `code`, or `pdf`. Inferred if omitted. |
| `content` | A single file as a string. |
| `files` | Instead of `content`: a map of path to content, with binary files in base64. For an HTML page with its CSS, JS, and images. |
| `entry` | Optional. The file to open first in a multi-file artifact. |
| `language` | Optional, for `code`. |
| `message` | Optional change note for this version. |
| `visibility` | Optional: `private` (the default), `team`, or `public`. |

It returns the artifact's `id`, the new `version`, and its view URL.

Inline `content` and `files` are capped at 2 MB in total. For anything larger, call `create_upload` to get a signed upload URL, upload the bytes there, and publish with the result. Files can be up to 25 MB each and 100 MB per publish.

## Reading

- `get_artifact`: metadata plus the content of a version, the latest by default.
- `list_artifacts`: filter by owner, format, visibility, agent, or updated-since. Paginated.
- `search_artifacts`: full-text search over title, description, and extracted text. A PDF is searchable by its text once it has been viewed in the dashboard; before that, only by title and description.

## Versions

- `list_versions`: the history, with the agent and change note for each version.
- `restore_version`: restores an earlier version by publishing it as a new one.

## Sharing

- `share_artifact`: gives an email address `viewer` or `editor` access. The person doesn't need to have signed in yet.
- `unshare_artifact`: removes that access.
- `set_visibility`: `private`, `team`, or `public`.

Only an artifact's creator can share it, change its visibility, or delete it.

## Deleting

`delete_artifact` moves an artifact to the trash. It can be recovered for 30 days, then it's purged.

## Live-page data

`artifact_data_get`, `artifact_data_list`, `artifact_data_query`, `artifact_data_set`, `artifact_data_update`, and `artifact_data_delete` read and write an artifact's live-page data. It's the same store the [runtime API](/docs/runtime-api/) uses, so an agent can seed a tracker or read a poll's results.

## REST API

`/api/v1/` mirrors these operations for the dashboard and for scripts, with the same tokens.
