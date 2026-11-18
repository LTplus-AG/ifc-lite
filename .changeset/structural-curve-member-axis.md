---
"@ifc-lite/export": patch
---

IFC4 -> IFC2X3 conversion keeps a structural curve member's `Axis` as `IfcRelAssociatesProfileProperties.ProfileOrientation`, turned into the analysis model frame, and IFC2X3 -> IFC4 reads it back for placed members too, so a round trip gives back the source records (#9668).
