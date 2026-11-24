---
"@ifc-lite/export": patch
---

The conversion loss report no longer names `MoveFrom`, `MoveTo`, `PunchList` or `ActionID` as lost when an IFC2X3 `IfcMove` or `IfcOrderAction` upgraded to `IfcTask` leaves that slot unset. A slot the record populated is still reported.
