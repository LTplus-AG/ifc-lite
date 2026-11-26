---
"@ifc-lite/export": patch
---

The conversion loss report no longer names an attribute as lost when the source record leaves it unset, for every type-wide drop in either direction, as the Rust exporter counts. For example, an IFC2X3 `IfcRelAssignsTasks` with `TimeForTask` unset, an `IfcWorkPlan` with `UserDefinedControlType` unset, or an IFC4 `IfcWall` downgraded with `PredefinedType` unset. A populated slot, including `''` and `()`, is still reported, and so is a record the target schema cannot hold at all.
