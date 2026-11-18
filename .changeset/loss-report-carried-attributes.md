---
"@ifc-lite/export": patch
---

`analyzeConversionLoss` now follows the export in three more structural cases (#10597). It names the CausedBy of an IFC2X3 varying action that the upgrade reports, under the type the export writes the action as, one record group per type. It counts nothing as carried for a record split over lines, which the writer passes through unconverted. It reports a curve member's Axis lost when the association the export would fill is split over lines.
