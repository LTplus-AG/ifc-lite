---
"@ifc-lite/clash": minor
---

Clash detection no longer treats non-physical / non-product geometry as a clash
candidate (#1464). Spatial volumes (`IfcSpace`, `IfcSpatialZone`), voids
(`IfcOpeningElement`/`IfcOpeningStandardCase`), `IfcVirtualElement`, reference
geometry (`IfcGrid`, `IfcGridAxis`, `IfcAnnotation`) and non-product material
associations are dropped from the candidate set in `elementsFromStep`, so a
"detect all" run and per-rule runs only ever consider real building elements
instead of surfacing phantom clashes that no rule referenced.
