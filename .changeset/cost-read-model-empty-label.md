---
"@ifc-lite/parser": patch
---

The cost read model no longer collapses an explicit empty `IfcLabel`/`IfcText` (`''`) to absent. `IfcCostSchedule.Name`/`Identification`/`Status`, `IfcCostItem.Name`/`Description`/`ObjectType`/`Identification`, `IfcCostValue.Name`/`Description`/`Category`/`Condition`/`CostType`, `IfcCostQuantity.Name`/`Description`/`Formula`, unit `Name`/`Symbol`, and relationship `GlobalId`/`Name`/`Description` now keep `''` distinct from an unset (`$`) attribute, matching IfcOpenShell (#4881).
