---
"@ifc-lite/renderer": patch
---

Add `Scene.clearFlatGeometry()`: resets flat/batched geometry (meshes, batches, buckets, textured meshes, colour overlays, streaming state) without destroying GPU-instanced templates. `Scene.clear()` is unchanged (still a full reset — flat geometry AND instanced templates) but is now implemented as `destroyAllInstancedTemplates()` + `clearFlatGeometry()` internally.

This exists so a caller that reshapes the scene (a visibility toggle, an in-place content mutation, a federated model add) while at least one model is still present can retain that model's instanced geometry instead of losing it permanently — nothing re-uploads GPU-instanced templates once they're destroyed, since the instancing shard bytes are dropped after their one-time drain. Pair `clearFlatGeometry()` with `removeInstancedTemplatesForModel()` for any model that did NOT survive the reshape, to keep the invariant that only present models' instanced geometry stays visible.

`clearFlatGeometry()` also stops unconditionally clearing `boundingBoxes`: an id with a surviving instanced occurrence keeps its cached box (needed for raycast/measure to keep working on retained geometry); an id with no surviving occurrence anywhere (flat or instanced) still has its box dropped, matching the previous behaviour for pure flat geometry.
