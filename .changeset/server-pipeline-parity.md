---
'@ifc-lite/server-client': minor
---

Server pipeline parity (alignment audit follow-up):

- New `ParseRequestOptions.tessellationQuality` option on `parse` / `parseParquet` / `parseParquetStream` / `parseParquetOptimized` / `parseStream` — the server now honours the same `lowest…highest` detail levels the wasm path exposes via `setTessellationQuality` (#976's server half). Default stays `medium`, byte-identical to historical output, and maps to the pre-existing cache keys.
- The cached-geometry fast path forwards the quality option, so a `high` request can never be served a `medium` cache entry.
- Fixed the "[client] Cache key mismatch" warning that fired on every fresh upload: the server cache key is the file hash plus request suffixes, so the sanity check now verifies derivation instead of equality.
