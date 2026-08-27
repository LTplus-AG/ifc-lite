---
'@ifc-lite/cache': patch
---

A cache load no longer renames an element to "Unknown" when its IFC class has no `IfcTypeEnum` member.

`EntityTable` carries a `rawTypeName` string column so `getTypeName()` can name a class the hand-maintained `IfcTypeEnum` does not cover — 101 of the 157 concrete `IfcProduct` subtypes in the bundled IFC4 registry, `IfcPump`, `IfcValve`, `IfcAirTerminal`, `IfcBoiler` and `IfcSurfaceFeature` among them. The cache writer never serialized that column and the reader's hand-rolled `EntityTable` had no fallback for it, so every such element came back from a cache hit as "Unknown" while the same model parsed from source named it correctly.

The column is now written (cache format v15, appended after the type-range triples so a v14 section stays readable and version-gated on the way in), and `readEntities` builds its table through `entityTableFromColumns` — the same constructor the parser path uses — instead of keeping a second copy of the accessor closures. That duplicate is what let the fallback go missing on one side only.
