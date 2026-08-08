---
"@ifc-lite/sandbox": patch
---

Fix `bim.store.addBeam` accepting `storeyExpressId: 0` in a sandboxed script. Every other `bim.store.addX` method (`addColumn`, `addWall`, `addSlab`, `addDoor`, `addWindow`, `addSpace`, `addRoof`, `addPlate`, `addMember`) shares `requireStoreyId`, which rejects `storeyExpressId <= 0` since EXPRESS ids are 1-based and `#0` is never a valid reference. `addBeam` alone duplicated the check inline and only rejected negative values, letting `0` through with a less specific downstream error (`resolveSpatialAnchor: storey #0 has no resolvable IfcLocalPlacement` instead of the bridge's own "storeyExpressId must be a positive integer" message). No entity was ever created either way — `resolveSpatialAnchor` throws before any STEP records are emitted — so this was an error-message inconsistency, not silent data corruption. `addBeam` now uses the same shared `requireStoreyId` helper as its siblings.
