---
"@ifc-lite/export": patch
---

The conversion loss report no longer names an attribute as lost when a type-wide drop leaves it unset, for types without an upgrade attribute map too. For example, an IFC2X3 `IfcRelAssignsTasks` with `TimeForTask` unset, or an `IfcWorkPlan` with `UserDefinedControlType` unset. A populated slot is still reported.
