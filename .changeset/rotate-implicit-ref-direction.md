---
"@ifc-lite/create": patch
"@ifc-lite/viewer": patch
---

`rotateProductYaw` no longer refuses a parsed element whose `IfcAxis2Placement3D` leaves `RefDirection` implicit (`IFCAXIS2PLACEMENT3D(#p,$,$)`), the form exporters that omit default axes emit routinely, and neither do `transformElementsInStore` or the viewer's rotate. The implicit slots are first written explicitly with the frame they stand for — `Axis` as `(0,0,1)` when it too is implicit, `RefDirection` as the `firstProjAxis(Axis)` fill — through the caller's editor, so an atomic or compound caller groups the materialisation and the rotation into one undo step. Placements that already carry an explicit `RefDirection` still rotate in place, now keeping a tilted direction's in-plane length; a vertical `RefDirection` is refused before any write (#8446).
