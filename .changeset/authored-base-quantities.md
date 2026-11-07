---
"@ifc-lite/create": minor
"@ifc-lite/export": patch
"@ifc-lite/mutations": minor
"@ifc-lite/viewer": patch
---

Walls, slabs, roofs, columns and beams authored in the Model workspace now carry base quantities (#9026). `deriveAuthoredBaseQuantities` reads `Qto_WallBaseQuantities`, `Qto_SlabBaseQuantities`, `Qto_RoofBaseQuantities`, `Qto_ColumnBaseQuantities` and `Qto_BeamBaseQuantities` off an overlay-created element's live geometry, so they follow every resize, split, door cut and undo with nothing to refresh, and net values subtract openings. Installed as the mutation view's quantity base, they reach the Properties and Measure panels and the STEP export alike. A derived set's GlobalId, and its relationship's, are named from the element, so exporting the same model twice writes the same file. A loaded file's elements are unchanged. `QuantityExtractor` now also receives the asking view and the entity id before aliasing.
