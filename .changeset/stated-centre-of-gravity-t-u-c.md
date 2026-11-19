---
"@ifc-lite/create": patch
---

Derive now uses the stated IFC2X3 centre of gravity of T, U, C and asymmetric I profiles, under the rule it already applied to L profiles (#10377). The value is the distance from the centre of the bounds, as the IFC2x3 TC1 text defines it for each type. It is used only when it is within 10% of the computed offset and that reading can be told apart from a distance measured from the outer edge. The sign always comes from the computed centroid, so an asymmetric I with the wider flange on top keeps +y where TC1, which assumes the wider flange at the bottom, says -y. Each type, the L included, is read only at its IFC2X3 attribute count, so an IFC4 asymmetric I's BottomFlangeEdgeRadius, which reuses the old slot, is never taken for a centre of gravity.
