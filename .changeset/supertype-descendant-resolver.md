---
'@ifc-lite/data': minor
'@ifc-lite/parser': patch
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
'@ifc-lite/viewer': patch
---

`byType()`, shared by `ifc-lite query --type`, MCP's `query_entities`/`count_entities` and the viewer SDK, expanded a caller's type through a fixed nine-entry table that only aliased `*StandardCase`/`*ElementedCase` pairs. An abstract EXPRESS supertype (`IfcBuildingElement`, `IfcElement`, `IfcBuiltElement`) is never a literal STEP entity type, so that table had no row for it and the query silently answered zero on a model full of walls, slabs and columns.

`@ifc-lite/data` gains `expandTypeNamesToDescendants`, a descendant-closure resolver over the bundled `ENTITIES_IFC2X3`/`ENTITIES_IFC4`/`ENTITIES_IFC4X3` tables, and `@ifc-lite/parser`'s `expandTypes` delegates to it. Both take the queried model's `schemaVersion`, and `validate`'s scanned type lists are computed per store for the same reason.

Three things about the resolution are deliberate:

- **It reads the file's own schema first, and the other tables only for spellings that schema does not have.** Three parts: (a) the descendants the file's own schema table declares; (b) plus names that table does not declare *at all* and that are descendants of the requested type in the table that does declare them, which is how an IFC4X3-headered file still carrying `IFCSLABSTANDARDCASE` is found (`entityIndex.byType` is keyed by the names a file contains, not by what its `FILE_SCHEMA` header claims, and re-headered files are common); (c) plus the two alias relations below. A name the file's own schema declares under a different parent is never added: buildingSMART re-parented entities between versions, so a plain union would answer `byType('IfcBuildingElement')` on an IFC4 file with reinforcing bars, `byType('IfcObject')` with the `IfcProject`, and `byType('IfcSystem')` on IFC2X3 with an `IfcZone`.
- **Cross-schema renames and the aliased leaves resolve too.** `IfcBuildingElement` and `IfcBuiltElement` reach each other's subtypes, and `byType('IfcGeotechnicalStratum')` now finds `IfcSolidStratum`/`IfcVoidStratum`/`IfcWaterStratum`, which no bundled table declares.
- **The expansion does not cross an `IfcRoot` branch.** Descending the whole hierarchy from `IfcRoot` or `IfcObjectDefinition` would answer with every rooted record in the file (property sets, relationships, type objects), which contradicts what the same backends answer for an unfiltered query and breaks `group_by: storey`. A type named explicitly is never gated, so `byType('IfcPropertySet')` still works.

The expansion order is now the requested type followed by its descendants sorted, rather than depth-first traversal order: callers page these results with `offset`/`limit`, and traversal order would shift a caller's page whenever the generated schema tables were regenerated.

IDS entity-facet matching is unchanged, per the buildingSMART IDS spec's no-automatic-inheritance rule (now cited in a code comment on `checkEntityFacet`).
