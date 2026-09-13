---
"@ifc-lite/server-bin": patch
---

Retire parse responses cached before the `IfcMapConversionScaled` factors reached the server payload. Those entries have no `factor_x`, `factor_y` or `factor_z`, so a client reading a cache hit applied a scale of 1 to a scaled file. The JSON response key moves to `-json-v4`, the Parquet metadata header to `-parquet-metadata-v5`, and the optimized metadata header to `-parquet-optimized-metadata-v2`; each affected file is parsed once more on its next request. `GET /api/v1/cache/check/{hash}` now also requires the current metadata header. Without that, a file with geometry cached from before this change would report a hit, and the `GET /api/v1/cache/geometry/{hash}` fetch that follows would answer 404.
