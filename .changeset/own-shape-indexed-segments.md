---
"@ifc-lite/data": minor
"@ifc-lite/mutations": minor
"@ifc-lite/export": minor
---

Typed STEP attribute markers also accept positive integer arrays for `IfcLineIndex` and `IfcArcIndex`, preserving IFC4 indexed-polycurve segments when copying a file element with its own shape. Invalid segment aggregates refuse export.
