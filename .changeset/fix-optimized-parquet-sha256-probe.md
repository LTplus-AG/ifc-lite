---
'@ifc-lite/server-bin': patch
---

Fix `POST /api/v1/parse/parquet/optimized` being unreachable by hash: it now accepts a `?sha256=` hash-only replay probe (same contract as `parquet-stream`), and `GET /api/v1/cache/:key` answers 404 instead of 500 for a cached entry that is not a JSON `ParseResponse` (e.g. a binary Parquet body).
