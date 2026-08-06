---
"@ifc-lite/viewer-core": patch
---

Fix `ifc-lite view` rendering every element stacked at the scene origin.

The wasm mesh contract hands back a per-element local frame: the world position of vertex `i` is `origin + positions[3i..3i+3]`. The standalone viewer blob buffered `positions` raw and never read `origin`, so each element was drawn around 0,0,0 with only its own local extents — a whole building collapsed into one overlapping pile. On the reporter's file all 119 meshes carry a non-zero origin (an `IfcColumn` at `(0.05, 12.20, -43.18)` with vertices within a metre of local zero), and the scene bounds came out 25.0 x 25.5 x 12.0 m instead of the model's real 29.9 x 27.4 x 46.4 m.

`addMeshBatch` now folds the origin into the vertices once, up front, so rendering, camera fit, picking bounds, zoom/isolate, section planes and storey binning all read world space — they all consume what that one function stores. Both batch mappings (`loadModel` and the `addGeometry` command) forward `origin` through to it.

Origins are already RTC-relative (`processGeometryBatch` subtracts the pre-pass `rtcOffset`), so folding into the f32 vertex buffer cannot reintroduce georeferencing jitter. The main web viewer at ifclite.dev already folded the origin, which is why it rendered the same files correctly.
