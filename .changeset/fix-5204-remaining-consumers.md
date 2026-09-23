---
"@ifc-lite/parser": minor
"@ifc-lite/mcp": patch
"@ifc-lite/export": patch
---

Every schema-specific reader of the IFC4 entity table now uses `ENTITIES_IFC4_EXPRESS`, a new `@ifc-lite/parser` export (#5204). It is `@ifc-lite/data`'s `ENTITIES_IFC4` checked against the EXPRESS-derived IFC4 registry. Rows IFC4 does not declare are dropped: the 24 draft alignment-extension entities such as `IfcAlignment2DHorizontal` and `IfcLinearPlacement`. Attribute lists come from the registry, so `IfcCartesianPointList2D`/`3D` lose the IFC4X3-only `TagList`. The attribute-less defined-type rows are kept. This fixes:
- `getAttributeNamesAcrossSchemas` / `isKnownType` in `@ifc-lite/parser`;
- the MCP schema tables in `@ifc-lite/mcp`;
- the subset-export attribute reader, the product/root type sets and the STEP retype re-layout in `@ifc-lite/export`. The retype re-layout could previously write a class IFC4 lacks, or a spurious `TagList` argument, into a file declaring `FILE_SCHEMA(('IFC4'))`.
