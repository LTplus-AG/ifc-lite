---
"@ifc-lite/export": patch
---

IFC2X3 ↔ IFC4X3 conversion maps `IfcStructuralLinearAction` and `IfcStructuralPlanarAction` by attribute name, as IFC2X3 ↔ IFC4 already did. Before, the two layouts have the same length, so a positional copy wrote `CausedBy` into `ProjectedOrTrue` and `ProjectedOrTrue` into `PredefinedType`. An upgrade now writes `ProjectedOrTrue` in its slot with `PredefinedType` `.CONST.`, and names the omitted `CausedBy` in the export warnings.
