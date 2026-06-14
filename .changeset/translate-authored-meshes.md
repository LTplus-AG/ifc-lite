---
"@ifc-lite/renderer": patch
---

Fix `Scene.translateMeshesForEntity` skipping single-entity meshes. The move
gizmo couldn't move an authored element (a baked IfcSpace, or an added
slab/wall/…) even though its placement and bounding box resolved: those meshes
tag every vertex with their own entity id for picking, and the translate path
skipped *any* mesh with a non-empty `entityIds` (meant to protect shared
colour-merged meshes from dragging unrelated entities). Now it skips only a
genuine merge — one whose vertices carry a *different* entity id — so a
single-entity mesh (all vertices tagged with the target id) translates as
expected. Parsed single-entity meshes (empty `entityIds`) are unaffected.
