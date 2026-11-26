---
"@ifc-lite/parser": patch
"@ifc-lite/data": patch
"@ifc-lite/rules": patch
---

`spatialHierarchy.elementToStorey` now names the storey of an element contained in an `IfcSpace` (or `IfcSpatialZone`) that the storey aggregates, and of that element's aggregated parts. Before, only elements the storey contained directly were mapped, so the same element had a storey after an edit and none on the parsed model.

The server's Rust data model (`element_to_storey` in `ifc-lite-processing`) applies the same rule, so server-parsed models answer the same: direct storey containment still wins, and a space reached through another space counts. An element reached through spaces on more than one storey (a malformed file) goes to the lowest storey express id on both paths, and the server now also maps the aggregated parts of a directly contained element to its storey, as the parser already did. In `@ifc-lite/rules`, the `storey in` prefilter used by AND queries now holds every element `elementToStorey` puts on the storey, so AND and OR return the same elements.
