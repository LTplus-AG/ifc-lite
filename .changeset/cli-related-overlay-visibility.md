---
'@ifc-lite/cli': patch
---

Fix `HeadlessBackend.query.related()`/`bim.related()` (and everything built on it — `bim.storey`, `bim.path`, `bim.contains`, `bim.decomposes`) answering about the parsed file instead of the session: `bim.store.addEntity('default', { type: 'IfcRelContainedInSpatialStructure', ... })` (or `IfcRelAggregates`, `IfcRelDefinesByType`, `IfcRelVoidsElement`, `IfcRelFillsElement`) followed by a `related()` query in the same session did not see the queued relationship, from either end.

`StoreEditor.addEntity` deliberately never touches `store.relationships` (the parsed file's immutable graph) — a queued `IfcRel…` record lives only in the `MutablePropertyView` overlay. `@ifc-lite/mcp`'s parallel `HeadlessLikeBackend` already folds queued relationships into `related()` for the same reason (#2014); this ports that half of the fix to the CLI, so a script using `@ifc-lite/cli` programmatically now sees the same read-your-own-write behaviour MCP already gives it for relationships. Property/quantity/attribute overlay folding, and `related()` visibility for newly-*created* entities (a gap in `entityData()`, tracked separately), remain out of scope here.
