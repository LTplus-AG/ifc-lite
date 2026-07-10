---
"@ifc-lite/renderer": minor
---

Opt-in LOD1 as a second index range (issue #1682, phase 5).

`Scene.setLodBuildsEnabled(true)` builds a vertex-clustering-simplified index buffer over each bucket batch's EXISTING vertex data at batch-build time (>= 500 source triangles, ~2% AABB-diagonal cell, skipped when it does not pay); `RenderOptions.lod.screenPx` draws it for batches projecting below the threshold. LOD costs index bytes only — no second vertex buffer, per-vertex entityId picking lane preserved, LOD0 geometry untouched (no-weld invariant intact). Off by default.
