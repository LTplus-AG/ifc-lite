---
"@ifc-lite/server-client": patch
---

Fix a mesh `origin` decode defect in `parquet-tables.ts`'s `transformFields`: `origin_x/y/z` are `Float64` columns server-side and can legitimately carry `NaN`/`Infinity` on a corrupted payload, but the truthiness check (`originX[index] || originY[index] || originZ[index]`) treated a NaN component as "present" whenever at least one of the other two components was truthy — a partially-NaN origin (e.g. `[NaN, 5, 0]`) rode straight through into `MeshData.origin`, where a NaN can later poison `expandModelBoundsWithFlatVertices` / scene-bounds arithmetic for the whole model. An all-NaN origin was already dropped (NaN is falsy), so the two corruption shapes were handled inconsistently.

Both now fall back to "no origin" — the same graceful degradation `originIsUsable` already applies to a structurally short/absent column set — rather than throwing, matching this file's existing convention of reserving thrown errors for structural malformation (missing columns, length mismatches, out-of-bounds ranges) and never for a value inside an otherwise well-formed float column. A normal finite origin and the existing all-zero-origin-omitted behavior are unchanged. Applies to both the standard (`buildMeshesFromTables`) and optimized/instanced (`buildMeshesFromOptimizedTables`) decode paths, which share `transformFields`.
