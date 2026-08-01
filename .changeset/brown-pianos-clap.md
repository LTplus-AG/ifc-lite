---
"@ifc-lite/renderer": minor
---

Fix rectangle select returning nothing on batched models. `PickingManager.pickRect` passed `Scene.getMeshes()` straight to the GPU pick pass, but batched geometry lives in `batchedMeshes` and never reaches that list, so Ctrl+drag deterministically produced an empty selection — reproducible at 8 meshes, not just on large models.

`pickRect` now takes the same route as `pick()`: hydrate the missing individual meshes when that fits the pick-mesh budget, otherwise fall back to CPU. The hydrate-or-fall-back decision both paths share is now a single code path, so they cannot drift again.

Adds `Scene.selectRect(...)`, the rectangle counterpart of `Scene.raycast(...)`, for the CPU fallback used when geometry data has been released or hydration would exceed the budget. Boxes are clipped against the near and far planes before projecting, so an element crossing the camera plane — the floor, ceiling and surrounding walls whenever you stand inside a model, which is exactly the population this path serves — contributes only its actually-visible screen extent rather than its full projected bounds.

Three divergences from the pixel-exact GPU pass remain, all of them over-selecting:

- Bounding-box granularity, so a rect covering only empty space inside an element's bounds still selects it.
- No depth test, so it selects through occlusion, where the GPU rect pass only ever sees front-most fragments.
- Whole-box section-plane and crop-box filtering: the CPU path skips an entity only when nothing of its box could be visible, whereas the pick shader discards per fragment, so a rect over the sectioned-away half of a box still selects it.

Hidden and isolation filtering do apply, per entity, exactly as on the GPU path.

Point clouds keep working on this path: splats render into the pick pass whether or not per-element mesh buffers were hydrated, so the CPU branch still runs a point-only GPU pass and unions its hits into the bounding-box result. Those point hits carry the section plane (the point picker clips on it) but not the crop box, and not the hidden/isolated sets — unchanged from the existing GPU rect pass, which has never filtered point nodes by those sets. If that point pass fails at readback, the rectangle select degrades to the bounding-box hits and logs, rather than failing outright.

Closes #1904.
