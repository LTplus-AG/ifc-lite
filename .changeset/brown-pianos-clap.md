---
"@ifc-lite/renderer": minor
---

Fix rectangle select returning nothing on batched models. `PickingManager.pickRect` passed `Scene.getMeshes()` straight to the GPU pick pass, but batched geometry lives in `batchedMeshes` and never reaches that list, so Ctrl+drag deterministically produced an empty selection — reproducible at 8 meshes, not just on large models.

`pickRect` now takes the same route as `pick()`: hydrate the missing individual meshes when that fits the pick-mesh budget, otherwise fall back to CPU. The hydrate-or-fall-back decision both paths share is now a single code path, so they cannot drift again.

Adds `Scene.selectRect(...)`, the rectangle counterpart of `Scene.raycast(...)`, for the CPU fallback used when geometry data has been released or hydration would exceed the budget. It is bounding-box granular — the same fidelity the released-geometry raycast path already has — so it can over-select slightly versus the pixel-exact GPU pass. Hidden, isolated, section-plane, and crop-box filtering all apply, so selection still matches what is visible.

Closes #1904.
