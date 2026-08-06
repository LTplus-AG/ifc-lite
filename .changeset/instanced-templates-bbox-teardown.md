---
"@ifc-lite/renderer": patch
---

Fix `Scene.removeInstancedTemplatesForModel` leaving stale cached bounding boxes behind (#2073).

The method already freed a model's GPU-instanced templates and pruned `instancedEntityMap`, but never touched the `boundingBoxes` cache it also feeds. For an id whose occurrences were entirely in the removed model (instanced-only), the cached world AABB lingered after the geometry was gone, so `getEntityBoundingBox()` kept returning a box for nothing and the released-geometry bounding-box raycast could still pick an element with no remaining mesh. For an id shared across models (occurrences in more than one), the cached box is a union built at upload time, so pruning only the removed model's occurrences left the box sized for occurrences that no longer exist.

An id that also owns flat (non-instanced) geometry is unaffected: that mixed case is owned by `removeMeshesForEntity`'s flat-removal path, which already clears the cache on its own schedule.

`removeInstancedTemplatesForModel` has no caller yet (step 1 of the #2073/#1912 fix); this closes the gap before step 2 wires it up.
