---
title: Self-hosting costs
description: What an instance costs on Cloudflare's free and paid plans.
order: 7
---

Every feature works on the Cloudflare Workers Free plan. For personal use, an instance usually costs nothing.

## What it uses

| Cloudflare product | Used for |
|---|---|
| Workers | The app, the MCP server, the API, and artifact serving |
| D1 | Metadata and the search index |
| R2 | Artifact files and thumbnails |
| KV | OAuth state for MCP clients |
| Durable Objects | Live-page data, one per artifact |
| Access (Zero Trust) | Sign-in |

## Staying within the free plan

The free plan allows 100,000 Worker requests a day and 10 ms of CPU time per request. Open Artifacts is built to those limits:

- Markdown, code highlighting, PDFs, and diffs render in the viewer's browser, not the Worker.
- Large uploads stream straight to R2 instead of passing through the Worker.
- Every request path is tested against the CPU budget.

The dashboard's **Usage** page shows today's requests and database reads and writes, and warns as you near the limits. It needs an optional `ANALYTICS_TOKEN` secret with Account Analytics read access; without it, the page explains how to add one.

## When to upgrade

The free plan handles personal use; sustained bursts of large publishes can exceed the 10 ms CPU limit. Workers Paid ($5 a month) is recommended for heavy or team use.

Consider Workers Paid (from $5 a month) if you publish heavily, share public links that get a lot of traffic, or run busy live pages. Paid plans raise the request and CPU limits; nothing in Open Artifacts changes.

Cloudflare's free allowances change from time to time. Check Cloudflare's pricing pages for the current numbers.
