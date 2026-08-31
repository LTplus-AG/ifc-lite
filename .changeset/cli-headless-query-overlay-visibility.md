---
'@ifc-lite/cli': patch
---

Fix `HeadlessBackend.query`/`bim.query()` answering about the parsed file instead of the session: `bim.store.addEntity(...)` followed by a query in the same session did not return the new entity, and `bim.store.removeEntity(ref)` followed by a query still returned the entity it had just deleted.

`StoreEditor.addEntity`/`removeEntity` deliberately never touch `store.entityIndex` (the parsed file's immutable index) — writes live only in the `MutablePropertyView` overlay, and the CLI's query adapter read `store.entityIndex` alone. `@ifc-lite/mcp`'s parallel `HeadlessLikeBackend` already folds its overlay into every read for the same reason (#2004, #2014); this ports the entity add/remove visibility half of that fix to the CLI, so a script using `@ifc-lite/cli` programmatically now sees the same read-your-own-write behaviour MCP already gives it. Property/quantity overlay folding is unaffected — this is scoped to entity visibility.
