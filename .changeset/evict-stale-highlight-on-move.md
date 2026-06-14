---
"@ifc-lite/renderer": patch
---

Fix the ghost left when moving (or deleting/splitting) a selected element. The
per-entity selection-highlight meshes in `Scene.meshes` are frozen position
copies made at selection time and were only ever cleared by `clear()` — so an
element moved while selected (the gizmo holds the selection through the drag)
kept drawing its highlight at the OLD position, a faint duplicate. `Scene` now
evicts an entity's standalone highlight meshes (freeing their GPU buffers) in
`translateMeshesForEntity` and `removeMeshesForEntity`, so the highlight is
re-extracted from the entity's current geometry on the next frame.
