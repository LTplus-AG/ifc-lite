---
'@ifc-lite/server-bin': patch
---

Fix `GET /api/v1/cache/{key}` never hitting for the `cache_key` a `POST /api/v1/parse` returned, so `getCached(result.cache_key)` from `@ifc-lite/server-client` now returns the cached response instead of `null`: the route looks up the entry under the key the JSON parse route actually writes. Every Parquet replay (`POST /api/v1/parse/parquet` and `/parquet/optimized` hits, `GET /api/v1/cache/geometry/{hash}`, and the `parquet-stream` replay's `complete` event) now reports `stats.from_cache: true`, so `parseParquet()` no longer says `from_cache: false` on a warm cache.
