---
"@ifc-lite/data": minor
"@ifc-lite/parser": patch
"@ifc-lite/mcp": patch
"@ifc-lite/export": patch
"@ifc-lite/ifcx": patch
---

Every schema-specific reader of the IFC4 entity table now uses `ENTITIES_IFC4_EXPRESS`, a new `@ifc-lite/data` export (#5204). It is `ENTITIES_IFC4` checked against the IFC4 EXPRESS schema:
- Rows IFC4 does not declare are dropped. These are the draft alignment-extension entities such as `IfcAlignment2DHorizontal` and `IfcLinearPlacement`.
- Attribute lists follow EXPRESS, so `IfcCartesianPointList2D`/`3D` lose the IFC4X3-only `TagList`.
- The attribute-less defined-type rows are kept.

The corrections are generated from `@ifc-lite/parser`'s EXPRESS registry by `scripts/generate-ifc4-express-corrections.mjs`, and CI checks that they are up to date. This fixes:
- `@ifc-lite/data`: `getEntities('IFC4')`, `findEntity('IFC4', …)` and `expandTypeNamesToDescendants`, which is what the IDS auditor reads;
- `@ifc-lite/parser`: `getAttributeNamesAcrossSchemas` / `isKnownType`;
- `@ifc-lite/mcp`: the schema tables;
- `@ifc-lite/export`: the subset-export attribute reader, the product/root type sets and the STEP retype re-layout. The retype re-layout could previously write a class IFC4 lacks, or a spurious `TagList` argument, into a file declaring `FILE_SCHEMA(('IFC4'))`;
- `@ifc-lite/ifcx`: the building-element family.
