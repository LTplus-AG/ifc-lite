---
"@ifc-lite/server-bin": minor
---

`POST /api/v1/parse/parquet/optimized` now extracts and caches the data model the same way `/parse/parquet` does, written before the response goes out, and reports `data_model_stats` in its `X-IFC-Metadata` header. Previously only `/parse/parquet` and `/parse/parquet-stream` produced a data model, so a client using only the optimized route never got one.

`GET /api/v1/parse/data-model/{key}` now answers 404 when nothing is cached and no fill is in flight for that key, instead of an unconditional 202. 202 is now reserved for the one case where a background fill is genuinely running (the streaming route's post-`complete` data-model task).
