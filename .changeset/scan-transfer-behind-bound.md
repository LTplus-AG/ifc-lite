---
"@ifc-lite/wasm": major
---

Refuse registered mesh transfer observations that lie behind the IFC face. `planMeshTransfer` requires an explicit `maxBehindMetres` (bounded by `maxDistanceMetres`) and reports `unknownBehindSamples`: a same-facing scan surface deeper than that limit behind the face, such as the far side of a thin wall or furniture beyond it, keeps the existing appearance instead of being painted through. Coplanar captures are tolerated within f64 rounding under a zero limit.

**Migration:** every `planMeshTransfer` request must now set a finite `maxBehindMetres` in the inclusive range from `0` through `maxDistanceMetres`; `0` accepts only coplanar or in-front observations.
