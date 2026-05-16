---
"@ifc-lite/renderer": minor
---

Add `Scene.removeMeshesForEntity(expressId)` and `Scene.translateMeshesForEntity(expressId, delta)` plus their bulk variants so authoring actions can keep the rendered scene in sync with IFC mutations.

`removeMeshesForEntity` drops GPU buffers + bbox + meshDataMap entry for a tombstoned entity instead of relying on the visibility set — used by the viewer's split / delete pathway.

`translateMeshesForEntity` applies a renderer-frame delta in place on `MeshData.positions`, clears the entity's bounding-box cache, and marks affected buckets for re-batch on the next `rebuildPendingBatches`. Used by the viewer's `translateEntity` / `setEntityPosition` actions so the visible mesh follows the gizmo and the numeric-move card without a full reload.

For color-merged meshes (per-vertex `entityIds`), both helpers skip the shared geometry and just de-register / leave-alone the requested entity — the geometry is still real, only the IFC tombstone says we should stop counting it.
