---
'@ifc-lite/server-client': minor
---

`decodeOptimizedParquetGeometry` now accepts optimized-format version 3 (issue #3575), which carries a per-instance rotation (`rot0..rot8`, row-major 3x3) alongside the existing per-instance `origin_x/y/z` — the server's fix for rotated `IfcMappedItem` reuse (furniture, pipe runs, repeated structural members) that previously never deduplicated. `buildMeshesFromOptimizedTables` applies the rotation to the shared template's local vertices/normals before `origin` places them, so `world = origin + R * template_position`; version-2 payloads (no rotation columns) and any instance without a verified rotation decode exactly as before (identity rotation, origin-only placement).
