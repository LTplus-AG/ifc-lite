---
"@ifc-lite/create": patch
---

`resolveSpatialAnchor` now refuses (throws) rather than silently proceeding when a store's schema is IFC2X3 and it has no `IfcOwnerHistory` entity.

`IfcRoot.OwnerHistory` is optional from IFC4 onward but mandatory in IFC2X3. `resolveSpatialAnchor` previously resolved `ownerHistoryId: null` for any store missing `IfcOwnerHistory`, regardless of schema, and every in-store builder (`addWallToStore`, `addBeamToStore`, `addSlabToStore`, ...) emits `$` for a null `ownerHistoryId` unconditionally. Editing an IFC2X3 store that itself is missing `IfcOwnerHistory` (a malformed or hand-edited file) therefore silently authored new IFC2X3 elements with `$` in place of a mandatory attribute. IFC4/IFC4X3 stores are unaffected — OwnerHistory is genuinely optional there and `$` is correct.
