---
"@ifc-lite/mutations": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

Fix `StoreEditor.removeEntity()` returning `false` and deleting nothing for a property or quantity atom the parser deferred out of `entityIndex.byId` (`deferPropertyAtomIndex: true`, the canonical example in the parsing guide), even though `StoreEditor.hasEntity()` reported that entity present. Callers that ignore the returned boolean silently kept the entity. The source-index membership test is now one shared predicate, `storeHasSourceEntity(store, expressId)` (new export), used by `StoreEditor`'s `addEntity`, `removeEntity` and `hasEntity` and by the CLI and MCP headless backends, so these checks can no longer disagree about whether an entity exists.
