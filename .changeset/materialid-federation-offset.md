---
'@ifc-lite/viewer': patch
'@ifc-lite/geometry': patch
---

Re-home `MeshData.materialId` — the `IfcMaterial` express id a material-layer mesh slices (#3199) — by the federation id offset, alongside `expressId` and `geometryItemId` (#2985/#1781).

`materialId` was the one source id `applyFederationOffsetToMesh` left unshifted, by explicit exclusion (#3199/#3525): whether to move it depended on which id space its consumers expected, and offsetting a field a consumer indexed by local id would have been a regression rather than a fix.

Census of every TS-side reader of `MeshData.materialId` (`packages/geometry/src/geometry.worker.ts`, `geometry-coordinate.ts`, the binary cache round trip in `packages/cache/src/sections/geometry.ts`, `apps/viewer/src/utils/serverMesh.ts`) found none that index a store by the raw value or otherwise depend on it being model-local — every one only copies the field through. The five style-lookup sites #3211 found reading a material id as a representation item (`ctx.geometry_style_index` and siblings in `rust/processing/src/element.rs`) are a same-named but unrelated id: they run inside per-model Rust geometry production, before a federation offset exists at all.

With no settled consumer expecting local space, leaving `materialId` unshifted beside an already-global `expressId` on the same mesh reproduced the exact "resolves to a real entity in the wrong model" defect #2985 fixed for `geometryItemId` — worse than a miss, because it looks like an answer. `applyFederationOffsetToMesh` now shifts `materialId` the same way, with the same absence and `0`-is-not-absent guards as the other ids on the mesh.
