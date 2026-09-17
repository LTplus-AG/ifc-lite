---
"@ifc-lite/viewer": patch
---

Fix a wall/slab split leaving the source entity's mesh in the store after the removal drain: `useGeometryStreaming` now prunes the removed mesh out of `geometryResult.meshes` and subtracts its triangle/vertex counts, so the status bar's triangle count and collaboration room seeding stop overcounting and drifting with every split.
