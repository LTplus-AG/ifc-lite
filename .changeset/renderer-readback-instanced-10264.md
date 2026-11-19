---
"@ifc-lite/renderer": minor
---

Released-geometry readback for instancing and one-ray coverage (#10264):

- `materializeShardOccurrences(shard, modelIndex, keyPrefix, wanted?)` materializes the occurrences of a decoded instanced shard that is not on the GPU, for example one read back from local storage. It prepares them exactly as `Scene.addInstancedShard` does: opaque occurrences only, composed matrices, and canonical f64 anchors. The result is in the model's own frame, and its `occurrenceKey`s carry `keyPrefix`.
- `setReadbackRaycastMeshes(meshes, at?)` takes the canvas point the pieces were prepared for. They then answer only the ray through that point (within 1.5 CSS px) under the same view. `readbackRaycastCovers(x, y)` reports whether a ray is covered. A neighbourhood is not the whole scene, so any other ray could pass an unfed front surface and hit a fed piece behind it.
