---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/mutations": patch
"@ifc-lite/rules": patch
"@ifc-lite/viewer": patch
---

Apply the additive SI offset of an `IfcConversionBasedUnitWithOffset` (°F) wherever a resolved unit's scale is used: `scaleMeasureValue` / `scaledPropertyValue` (model diff) now gives 293.15 K for 68 °F instead of 37.78, and the viewer's display-unit conversion, chart field columns and table-cell write-back keep the unit's offset. `Property` gains an optional `unitSiOffset`, which the mutation overlay carries through. Rules, whose SI conversion is a factor only, report no SI factor for such a value instead of a wrong one.
