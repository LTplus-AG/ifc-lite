---
'@ifc-lite/server-bin': patch
---

Fix `?parquet_layout=shared-shapes` collating far less than `/optimized` on models with no `IfcMappedItem`/`IfcRepresentationMap` instancing metadata: `ShapePlan::shared_shapes` now runs the same content-hash fallback `/optimized` has always used for occurrences the rotation-aware collator did not place, so bit-identical repeats collapse onto one shape on both routes. Bumps the shared-shapes cache namespace from `-parquet-v6` to `-parquet-v7` so a warm cache cannot keep serving the pre-fix, uncollated bytes.
