---
"@ifc-lite/parser": patch
"@ifc-lite/data": patch
---

`spatialHierarchy.elementToStorey` now names the storey of an element contained in an `IfcSpace` (or `IfcSpatialZone`) that the storey aggregates, and of that element's aggregated parts. Before, only elements the storey contained directly were mapped, so the same element had a storey after an edit and none on the parsed model.
