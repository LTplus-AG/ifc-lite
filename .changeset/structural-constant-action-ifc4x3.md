---
"@ifc-lite/export": patch
---

IFC2X3 ↔ IFC4X3 conversion maps the slots of `IfcStructuralLinearAction` and `IfcStructuralPlanarAction` by attribute name, as IFC2X3 ↔ IFC4 already did. The two layouts have the same length, so before this a positional copy wrote `CausedBy` into `ProjectedOrTrue` and `ProjectedOrTrue` into `PredefinedType`. An upgrade now writes `ProjectedOrTrue` in its slot with `PredefinedType` `.CONST.`, and names the omitted `CausedBy` in the export warnings. Carrying `CausedBy` as a relationship stays IFC4-only.
