---
"@ifc-lite/ids": patch
---

The IDS bridge now converts a property or quantity by its OWN `Unit` when it declares one that resolves (#7395, part 1). It used to drop the unit the parser had resolved (`unitSiScale` on properties, `explicitUnitSiScale` on quantities) and apply the project's length/area/volume scale instead. In a metre project, an `IFCLENGTHMEASURE(100.)` with a millimetre unit of its own was compared as 100 m, so a requirement of 0.1 failed. The own unit now replaces the project's, never compounds with it, and carries its own dimension (an `IfcQuantityArea` in mm² converts by 1e-6). A value without an own unit converts as before. `applyUnitConversion` takes the own unit's scale as an optional last argument.
