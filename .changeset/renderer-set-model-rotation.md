---
"@ifc-lite/renderer": minor
---

Add `Renderer.setModelRotation(modelIndex, angle, pivot)` / `Scene.setModelRotation`, the GPU-instanced counterpart to `setModelTranslation`: it turns a model's instanced occurrences about a render-frame pivot on the vertical (+Y) axis, from a pristine per-instance baseline, so a whole-model rotation can reach instanced geometry (#4890). Flat/authored/batched geometry is unaffected — that half is rotated by the caller's own bake. Part of #4890; the viewer wiring that calls this from the reposition panel ships separately.
