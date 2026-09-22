---
"@ifc-lite/parser": patch
"@ifc-lite/mcp": patch
"@ifc-lite/export": patch
---

Fix the last three consumers of the wrong IFC4 entity table (issue #5204, addressed for `schema-converter.ts` in a prior fix): `getAttributeNamesAcrossSchemas`/`getAttributeNamesForSchema` (`@ifc-lite/parser`), the MCP `schema_describe`/query-backend attribute table (`@ifc-lite/mcp`), and both the subset-export attribute-index reader and the STEP retype re-layout (`@ifc-lite/export`) no longer answer for `IfcCartesianPointList3D`'s never-existed `TagList` attribute, and no longer present 24 draft-alignment-extension entities as IFC4-valid — the worst case being `retype.ts`, which previously could write an unconvertible class keyword or a spurious extra STEP argument into a file declaring `FILE_SCHEMA(('IFC4'))`.
