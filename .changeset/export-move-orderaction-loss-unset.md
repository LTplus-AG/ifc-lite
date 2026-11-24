---
"@ifc-lite/export": patch
---

The conversion loss report names an attribute lost by a type-wide drop only when the source record populated it. `MoveFrom`, `MoveTo`, `PunchList` and `ActionID` on an upgraded IFC2X3 `IfcMove` or `IfcOrderAction`, `TimeForTask` on an `IfcRelAssignsTasks`, and `UserDefinedControlType` on an `IfcWorkPlan` are no longer reported while unset (`$`); a populated slot, including `()` and `''`, still is.
