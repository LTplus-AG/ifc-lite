---
"@ifc-lite/create": minor
"@ifc-lite/export": minor
"@ifc-lite/sdk": minor
---

Storey authoring in a loaded model (#9013). `@ifc-lite/create` can now add, rename, re-level (by elevation or floor-to-floor height) and delete `IfcBuildingStorey` in a parsed model, with geometry following the storey. Contents move through real placement writes. Contents placed outside the storey's placement chain get their own lift, and other storeys' products are held in place. Every invalid outcome is refused before anything is written, including a duplicate `GlobalId` and a reviewed plan the model has moved on from (`editStorey` / `deleteStorey` take it as `expected`). `bim.store` exposes the same operations (`listStoreyLevels`, `addStorey`, `renameStorey`, `planStoreyEdit`, `editStorey`, `planStoreyDelete`, `deleteStorey`). `@ifc-lite/export` exports `effectiveReferencers`, the live reverse-reference lookup `editOwnershipRefusal` already used; it now also rescans edited deferred property atoms.
