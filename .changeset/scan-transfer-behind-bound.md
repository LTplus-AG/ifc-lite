---
"@ifc-lite/wasm": patch
---

Refuse registered mesh transfer observations that lie behind the IFC face. `planMeshTransfer` requires an explicit `maxBehindMetres` (bounded by `maxDistanceMetres`) and reports `unknownBehindSamples`: a same-facing scan surface deeper than that limit behind the face, such as the far side of a thin wall or furniture beyond it, keeps the existing appearance instead of being painted through. Coplanar captures are tolerated within f64 rounding under a zero limit.
