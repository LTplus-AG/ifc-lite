---
"@ifc-lite/renderer": patch
---

Fix picking of colour-merged fillers (IfcDoor / IfcWindow) under isolation. When a door or window is colour-fused into a batch keyed by its host wall or opening, its expressId lives only in the per-vertex `entityIds`, not in `batch.expressIds`. Picking now seeds its candidate set from the scene's authoritative mesh-data id set (`getAllMeshDataExpressIds()`), so an isolated door/window is hydrated and selectable instead of returning `null` from `pick()`. (#1358)
