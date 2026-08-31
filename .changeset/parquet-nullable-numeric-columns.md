---
'@ifc-lite/server-client': patch
---

`decodeDataModel` no longer fabricates `0` for a legitimately-null nullable numeric column. Both `elevation` (a storey whose elevation cannot be resolved) and `thickness` (every non-layer material association — single material, list, constituent) are server-emitted as nullable `Float64` Parquet columns; reading them via `Vector.toArray()` returns the column's raw values buffer, which carries `0` at a NULL row's slot rather than a detectable sentinel. A storey with no resolvable elevation, or a material that is not a layer, previously decoded with a real-looking `elevation: 0` / `thickness: 0` instead of `undefined` — silently wrong data that downstream code (which already checks `!== undefined` for both fields) could not distinguish from a genuine zero-elevation storey or a zero-thickness layer. Both columns are now read through a null-safe path (`parquet-nullable.ts`) that consults the column's own validity per null-containing row.
