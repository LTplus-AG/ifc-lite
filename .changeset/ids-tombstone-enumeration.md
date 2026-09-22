---
"@ifc-lite/ids": minor
"@ifc-lite/mcp": patch
---

`createDataAccessor`'s `getAllEntityIds()` enumerated a `store.removeEntity()`-deleted entity for IDS validation — a conformance validator counting, applying requirements to, and reporting on an element the caller had deleted. `createDataAccessor` now takes an optional third `entityVisibility` argument (`EntityVisibilityView`, satisfied structurally by a `MutablePropertyView`), consulted only by `getAllEntityIds()`: it excludes tombstoned entities and includes overlay-created ones still alive. Every existing call — including every call with no third argument — is unaffected: `createDataAccessor(store)` and `createDataAccessor(store, propertyOverlay)` behave exactly as before.

The MCP server's `ids_validate` tool now passes its model's mutation view, so a session that deletes an entity and then re-runs IDS validation gets the corrected `applicableCount` and cardinality result. The viewer's IDS validation (main-thread and worker) already picked this up through the same wiring.
