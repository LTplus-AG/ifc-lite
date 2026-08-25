---
"@ifc-lite/parser": patch
---

`byType('IfcFurnishingElement')` now returns furniture. `expandTypes` widens a
supertype to its subtypes through `IFC_SUBTYPES`, a hand-maintained table that
covered the nine `*StandardCase` families and nothing else — so an IFC4 model
whose furniture is `IfcFurniture` (which is what exporters write) answered a
query for the supertype with no rows at all. `IfcFurniture` and
`IfcSystemFurnitureElement` join the table, which fixes the CLI (`ifc-lite query
--type IfcFurnishingElement`, the `stats` element counts), the MCP
`query_entities` tool and the viewer's query adapter together, since all three
call the same shared table. The table is now pinned in tests against the
subtypes the generated `SCHEMA_REGISTRY` declares, in both directions, so it
cannot fall behind the schema again.
