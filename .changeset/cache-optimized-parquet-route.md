---
'@ifc-lite/server-bin': minor
---

`POST /api/v1/parse/parquet/optimized` is now cached, so a repeat request is a disk read instead of a full re-parse (#3889). The route was added without a cache key of its own, which left the two Parquet endpoints with opposite properties: the flat route stored its large payload and replayed it, while the optimized route rebuilt its small payload on every request, and got no benefit from a flat response cached seconds earlier either. On a 57.9 MB file the flat route roughly halved on its second call and the optimized route did not improve at all.

The optimized response now has its own key pair, `{sha256}-{filter}-parquet-optimized-v1` for the body and `{sha256}-{filter}-parquet-optimized-metadata-v1` for the `X-IFC-Metadata` header, `optimization_stats` included, so a replay reports what the live parse reported. They are a separate namespace from the flat route's `-parquet-v5` / `-parquet-metadata-v4` on purpose: the optimized payload is quantized and deduplicated, so a cached flat response must never satisfy the optimized route or the other way round. Bump the suffix on any change to the optimized payload's columns.

Two details of the write. It happens before the response goes out rather than in a background task, because this payload is the small one and a background write races the very next request, which is the request the cache exists to serve. And a hit requires the symbolic sidecar to still be present alongside the body and metadata: the optimized parse is what writes that sidecar, so replaying past a missing one would leave `GET /api/v1/parse/symbolic/{cache_key}` polling a key nobody writes.
