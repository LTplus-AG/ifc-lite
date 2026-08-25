---
'@ifc-lite/export': patch
---

Schema downgrade now trims an entity's trailing attributes from the generated buildingSMART schema tables rather than a hand-written count map. Converting to IFC2X3 previously left 63 entity types IFC4-shaped — `IFCMATERIAL('Concrete','C30/37 cast in situ',$)` in a file declaring IFC2X3, where `IfcMaterial` takes exactly one argument — along with `IfcMaterialLayer`, `IfcCostItem`, `IfcClassification`, `IfcWallStandardCase`, `IfcGrid` and every `IfcQuantity*`. IFC4X3 → IFC4 was not trimmed at all. Entities that inserted attributes mid-list rather than appending them (`IfcApproval`, `IfcTask`, `IfcMaterialProperties`, …) are still left untouched, since trimming their tail would shift values into the wrong slots.
