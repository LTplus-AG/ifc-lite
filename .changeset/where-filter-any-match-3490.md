---
'@ifc-lite/query': minor
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
'@ifc-lite/viewer': patch
---

`query --where` (and `query_entities`'s `property` filter over MCP) tested only the first same-named property or quantity set, so an entity was wrongly excluded when the value it should have matched lived on a later same-named set (#3490) — two `IfcPropertySet`/`IfcElementQuantity` entities sharing one name is legitimate (e.g. one from the type definition, one from the occurrence).

A filter is a predicate over the entity, so it now passes when ANY same-named set satisfies the operator, not just the first one found — uniformly across every operator, `!=` included. `@ifc-lite/query` adds `findAllPropertiesInSets`/`findAllQuantitiesInSets` (alongside the existing first-match `findPropertyInSets`/`findQuantityInSets`, which stay correct for value extraction — export, aggregation, display); `@ifc-lite/cli`'s `query --where` and the shared `HeadlessBackend.query.entities()` filter, and `@ifc-lite/mcp`'s `query_entities` filter, all switch to the any-match lookup. The viewer SDK's `entities()` filter now matches a property/quantity in ANY same-named set, not only the first.
