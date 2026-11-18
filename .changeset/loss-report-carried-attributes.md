---
"@ifc-lite/export": patch
---

The conversion loss report no longer lists CausedBy, SubsequentThickness, VaryingThicknessLocation or SelfWeightCoefficients as lost when the IFC2X3 <-> IFC4 export carries them. It reads the same carried-attribute table as the export's own warnings (#10597).
