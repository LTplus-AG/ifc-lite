---
'@ifc-lite/renderer': patch
---

Fix textured face sets rendering collapsed toward the world origin (#1973).

`transform_mesh_world_framed` (on by default for wasm) stores each element's vertices relative to a per-element `MeshData.origin`, keeping the world magnitude out of f32 so building-scale coordinates can't collapse adjacent vertices into degenerate fans. The contract downstream is `world = origin + position`.

The batch path honours it — `mergeGeometry` folds `origin` into the shared frame and draws with `translate(sharedFrameOrigin)`. The textured sub-pass hard-zeroed its model translation, so every textured mesh drew offset by `-origin`. On a typical textured export that is metres: on the reported model, 107 of 109 meshes are textured and every one of them has a non-zero origin, up to ~19 m. The whole model rendered as a crushed heap around the origin. CPU picking uses the correctly placed geometry, so clicking a visible texture selected nothing.

The zeroing was correct when written: the #961 orphan type-geometry path runs `transform_mesh_local`, which leaves positions absolute and `origin` at zero. #1793 then added the occurrence path (a `Body` textured `IfcTriangulatedFaceSet`, which is what real exporters write) via `apply_submesh_placement` → `transform_mesh_world`, producing local-frame positions and a non-zero origin — and the textured pass was not updated for it.

`TexturedMesh` now carries `origin`, applied as the draw's model translation. Interleaved vertex positions stay local: folding the world magnitude back into f32 vertex data would defeat the local frame this origin exists to provide. Both cases are covered — `origin == 0` for the orphan path is a no-op, `origin != 0` for occurrences is the fix.
