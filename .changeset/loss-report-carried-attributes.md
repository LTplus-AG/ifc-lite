---
"@ifc-lite/export": patch
---

`analyzeConversionLoss` no longer lists a record's CausedBy, SubsequentThickness, VaryingThicknessLocation, SelfWeightCoefficients or curve-member Axis as lost when the IFC2X3 <-> IFC4 export carries them. Given the store's source text, it asks the export's structural carriers per record, so a record a carrier declines is still reported, as the export reports it (#10597). It now also names the CausedBy of an IFC2X3 varying action the upgrade reports, under the type the export writes the action as. It treats a record split over lines, which the writer passes through unconverted, as carrying nothing, and it no longer throws on a file the export refuses for a shared load configuration. The preview assumes an unedited full export: an export with mutations or a subset does not arm these carriers, so it can drop an attribute the preview leaves out. `classifyEntityTypeConversion` is per type and unchanged.
