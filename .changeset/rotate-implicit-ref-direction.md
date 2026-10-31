---
"@ifc-lite/create": patch
---

`rotateProductYaw` no longer refuses a parsed element whose `IfcAxis2Placement3D` leaves `RefDirection` implicit (`IFCAXIS2PLACEMENT3D(#p,$,$)`), the form exporters that omit default axes emit routinely. The implicit slots are written explicitly with their STEP defaults first — `Axis` as `(0,0,1)` when it too is implicit, `RefDirection` as `(1,0,0)` — through the caller's editor, so an atomic or compound caller groups the materialisation and the rotation into one undo step. Placements that already carry an explicit `RefDirection` rotate in place exactly as before (#8446).
