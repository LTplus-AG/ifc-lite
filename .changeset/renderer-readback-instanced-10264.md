---
"@ifc-lite/renderer": minor
---

Released-geometry readback for instancing and one-ray coverage (#10264):

- `materializeShardOccurrences(shard, modelIndex, keyPrefix, wanted?, budgetBytes?)` materializes the occurrences of a decoded instanced shard that is not on the GPU, for example one read back from local storage. It prepares them exactly as `Scene.addInstancedShard` does: opaque occurrences only, composed matrices, and canonical f64 anchors. The result is in the model's own frame, and its `occurrenceKey`s carry `keyPrefix`. With `budgetBytes`, each occurrence is charged before it is expanded, and a `RangeError` is thrown as soon as the budget would be exceeded.
- `setReadbackRaycastMeshes(meshes, at?)` takes the canvas point the pieces were prepared for. They then answer only the ray through that point (within 1.5 CSS px) under the same view. `readbackRaycastCovers(x, y)` reports whether a ray is covered (never for a non-finite point). `readbackRaycastViewKey()` returns the view that coverage is stamped with: capture it before the pick and install only while it is unchanged. A neighbourhood is not the whole scene, so any other ray could pass an unfed front surface and hit a fed piece behind it.
