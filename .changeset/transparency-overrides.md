---
"@ifc-lite/renderer": minor
---

Add `transparencyOverrides?: Map<expressId, alpha>` to `RenderOptions` for
per-frame alpha control (X-Ray mode).

Non-selected meshes/batches whose `expressId` appears in the map render at the
override alpha through the existing transparent pipeline. Selected meshes are
exempt so highlight rendering stays opaque. Mixed batches (some entries
overridden, some not) take the minimum override alpha — the selection
highlight pass then re-renders selected meshes opaque on top, so the user sees
selection in full while the rest fades.

Use case: viewers that want a true see-through "X-Ray" effect (selection visible
through ghosted geometry) instead of fully hiding non-selected elements via
`isolatedIds`.

Per-batch alpha resolution walks `batch.expressIds` per frame. For typical batch
sizes the cost is well below noise vs. the GPU work, and callers supply a fresh
Map when contents change (same convention as `hiddenIds`/`isolatedIds`). Routing
is purely per-frame — no mutation of `batch.color`, so IFC-declared alpha baked
into cached batches stays untouched.

Also fixes a correctness bug in partial sub-batch pipeline selection: when
X-Ray + hide/isolate combine, the pipeline now uses the resolved override alpha
(via `alphaForBatch`) instead of the parent batch's original `color[3]`, ensuring
transparent overrides route through the transparent pipeline with proper blending.
