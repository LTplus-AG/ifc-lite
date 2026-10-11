---
"@ifc-lite/ids": patch
---

Predefined property sets and a type object's own property sets now go through the same base-SI conversion as instance property sets (#7395, part 2). Before, a length, area or volume attribute of a predefined property set (`IfcDoorPanelProperties.PanelDepth`, an `IfcPositiveLengthMeasure`) was surfaced in the project's raw unit, and so was a type object's own `HasPropertySets` when the IDS checks the type object itself. In a millimetre project, a 50 mm panel depth was compared as 50 m. Non-measure attributes (enumerations, ratios, labels) are unchanged, and so are type property sets that an occurrence inherits, which were already converted.
