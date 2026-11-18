---
"@ifc-lite/export": patch
---

`analyzeConversionLoss` no longer lists a record's CausedBy, SubsequentThickness, VaryingThicknessLocation or SelfWeightCoefficients as lost when the IFC2X3 <-> IFC4 export carries them. Given the store's source text, it asks the export's structural carriers per record, so a record a carrier declines is still reported, as the export reports it (#10597). `classifyEntityTypeConversion` is per type and unchanged.
