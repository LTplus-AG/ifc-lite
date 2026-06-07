---
"@ifc-lite/wasm": minor
---

Expose per-entity geometry hashes from `processGeometryBatch`:
`IfcAPI.setComputeGeometryHashes(enabled, tolerance)` plus the
`MeshCollection.geometryHashCount` / `geometryHashIds` / `geometryHashValues`
getters. RTC-invariant and opt-in (off by default, so normal rendering pays
nothing); consumed by the model-diff / compare feature to detect per-element
geometry changes across revisions.
