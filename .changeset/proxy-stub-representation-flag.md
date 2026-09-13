---
"@ifc-lite/parser": patch
"@ifc-lite/data": patch
---

`EntityFlags.HAS_GEOMETRY` (and `entities.hasGeometry()`) now reflects an `IfcProduct` descendant's own `Representation` attribute presence instead of a class-bucket guess. Previously every entity of a class in the geometry bucket (`IfcElement`, `IfcSpace`, `IfcSite`, …) was stamped `HAS_GEOMETRY` unconditionally, so a placement-only stub — e.g. an `IfcBuildingElementProxy` authored with `Representation` set to `$` — reported geometry it did not have (#4666). The flag still does not cover geometry contributed only by aggregated (`IfcRelAggregates`) children: a container whose own Representation is `$` reads `false` even when its aggregated parts have geometry.
