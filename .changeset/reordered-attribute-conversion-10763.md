---
"@ifc-lite/export": patch
---

Schema conversion between IFC2X3 and IFC4/IFC4X3 now writes 22 entity types whose attributes IFC4 inserted, reordered or retyped mid-list (IfcApproval, IfcTask, the construction resources, IfcCostSchedule, the textures, IfcLibraryInformation and others) in the target's layout, from a reviewed per-type attribute map. Before, they kept the source layout, so values landed in the wrong slots. Values with no target slot are reported as dropped. IFC4 `IfcMaterialProperties` and `IfcProfileProperties` now downgrade to `IfcExtendedMaterialProperties` and `IfcGeneralProfileProperties`, since their IFC2X3 namesakes are abstract.
