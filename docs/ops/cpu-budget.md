# CPU budget

Open Artifacts targets the Cloudflare Workers **Free** plan, where an
invocation should stay under **10 ms of CPU**. This page records how we
measure that and the decision we took for 0.2.0.

## Decision (2026-10-19)

The bar is **p95 ≤ 10 ms CPU for personal-scale traffic**, meaning requests
at least ~3 s apart. Every route meets it.

Back-to-back large HTML publishes (250 KB, 2 s apart) still have a tail
(p95 16 ms). That burst pattern isn't realistic personal use, and Cloudflare
tolerates occasional overruns. For heavy or team use, Workers Paid ($5/mo) is
recommended; the self-hosting costs doc says so.

Follow-ups, which don't block 0.2.0:
- Inline HTML publishes over 128 KB go through the upload path, with text
  extraction only in the indexing alarm.
- The indexing alarm itself gets to p95 ≤ 10 ms.

## How we measure

Measurements run on **staging** after a deploy, using `wrangler tail`. Each
request carries a unique `?bench=<label>` marker, or a unique search term for
search, so other traffic is never counted. Every artifact the bench creates
is private and deleted afterwards. A tail event doesn't flag cold starts, so
"first" means the first request of a run right after a deploy.

## Results

cpuTime in ms. 20 runs per route unless noted.

### After #141 (c5dda24): mixed load, 2 s between requests

| Route | p50 | p95 | max | over 10 ms |
|---|---|---|---|---|
| `GET /healthz` | 0 | 1 | 1 | 0 |
| publish md 250 KB | 5 | 8 | 8 | 0 |
| publish html 100 KB | 4 | 8 | 8 | 0 |
| `GET /api/v1/artifacts?limit=25` | 6 | 10 | 10 | 0 |
| search | 5 | 10 | 13 | 1 |
| publish html 250 KB | 7 | **16** | 22 | 7 |
| indexing alarm (n=60) | 6 | **11** | 13 | 7 |

### After #141: publishes 3 s apart

| Route | p50 | p95 | max | over 10 ms |
|---|---|---|---|---|
| publish html 250 KB | 4 | 6 | 9 | 0 |
| publish md 250 KB | 4 | 6 | 7 | 0 |
| publish html 100 KB | 4 | 6 | 7 | 0 |
| indexing alarm (n=60) | 6 | 9 | 11 | 1 |

### GET routes in isolation, 50 back-to-back runs

| Route | p50 | p95 | max |
|---|---|---|---|
| `GET /healthz` | 0 | 1 | 1 |
| `GET /api/v1/me` (authenticated) | 2 | 4 | 5 |
| `GET /api/v1/artifacts?limit=25` | 3 | 5 | 11 (once) |

Run on their own, GET routes are cheap. Their tails appear only when they
share an isolate with recent large publishes and alarms.

### History

These numbers drove contract change C3 and the follow-up perf PRs.

| Change | Finding |
|---|---|
| Before C3 | 1.9 MB HTML publish at 40–83 ms. The cost was body handling, not indexing: base64 with no indexing was just as expensive. |
| #120 | Steady state: md 256 KB 7–9 ms, html 256 KB 12–28 ms |
| C3 (#126) | Inline publishes capped at 256 KB (larger returns 413, at 3–4 ms). Indexing moved to a Durable Object alarm. Steady state 4–9 ms, with a cold mode of 20–41 ms. |
| #134 | Eager isolate init plus the 128 KB index cap. Cold firsts dropped. |
| #141 | The table above. |

## Re-running

The bench scripts live in the Platform lead's scratchpad: `publish-bench.sh`
(mixed and spaced runs, knobs `SCEN`, `REPS`, `PUB_SLEEP`, `GAP`) and
`get-bench.sh`. They need the staging member PAT and a `wrangler` login. Ask
the Platform lead to run them after any change on a hot path.
