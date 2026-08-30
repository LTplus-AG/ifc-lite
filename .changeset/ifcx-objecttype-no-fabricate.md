---
'@ifc-lite/ifcx': patch
---

Fix `extractEntities` fabricating `ObjectType` from the IFC class code for every entity read from an IFCX archive — `entities.getObjectType(id)` for an entity of class `IfcWall` returned the string `'IfcWall'` instead of `''`, even though IFCX's official v5a `prop` schema defines no `ObjectType` attribute for the extractor to have read.

Any consumer of `ObjectType` (CSV/Parquet export, the query engine's `ObjectType` column, IDS's `getObjectType`, the lens summary line) saw this fabricated value for every IFCX-sourced entity, indistinguishable from a real authored `ObjectType`. The STEP parser's own default for an entity with no real `ObjectType` attribute is `''` (`packages/parser/src/columnar-parser.ts`); `entity-extractor.ts` now matches that instead of substituting the class code.
