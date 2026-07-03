---
"@ifc-lite/cache": patch
---

Bump the geometry cache `FORMAT_VERSION` 11 -> 12 for the source vertex weld. Element meshes are now welded at the source and the per-export welds were removed, so a v11 cache holds pre-weld (per-face-duplicated) geometry; restoring it and exporting would emit an unwelded, 3-6x larger GLB (regressing the export-weld win for cached-model users) and hand non-watertight raw MeshData to render/GLB consumers. The bump invalidates pre-weld caches so they re-mesh (welded) instead of restoring stale geometry.
