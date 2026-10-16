---
'@ifc-lite/server-bin': major
---

**Migration: the `complete` event of `POST /api/v1/parse/stream` no longer carries `cache_key`. That route caches nothing, and the value it sent (the bare file SHA-256) named no cache entry: `GET /api/v1/cache/{key}` refused it with a `400`. Use `POST /api/v1/parse` or a Parquet route when you need a key to fetch by later. `GET /api/v1/parse/symbolic/{key}` now answers `404` for a key nothing is writing (it answered `202` forever); poll on `202` and stop on `404`, as for the data model.**

Cache reads and cache-entry policy for a multi-tenant server (#7676):

- Every route that hands back a stored model (`/cache/{key}`, `/cache/geometry/{hash}`, `/parse/data-model/{key}`, `/parse/symbolic/{key}`, the `?sha256=` probes) is admitted for the stored entry's size rather than `MAX_FILE_SIZE_MB`, and every response that holds a model in memory keeps its bytes reserved until the client has read it, while giving its parse slot back at once. A hit can answer `503 OVERLOADED` with `Retry-After` under memory pressure. `GET /cache/check/{hash}` and the probes' miss path no longer read any stored content.
- A damaged cache entry (a torn write, a partial GC) is a miss on every route: an upload re-parses and rewrites it, a read-only route answers `404`, and the entry is dropped so `cache/check` stops reporting it. Three routes answered `500` for such a file on every request.
