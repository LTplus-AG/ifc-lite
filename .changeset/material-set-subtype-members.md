---
"@ifc-lite/parser": patch
---

Material sets whose members are `IfcMaterialLayerWithOffsets` or `IfcMaterialProfileWithOffsets` (IFC4 subtypes of `IfcMaterialLayer` / `IfcMaterialProfile`) now resolve their members. Previously the exact-name member test dropped every such layer or profile, so the set came back empty and flagged unresolved, losing thickness and material.
