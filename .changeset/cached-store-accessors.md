---
"@ifc-lite/parser": minor
---

Add `attachDataStoreAccessors(store)`, the single home for wiring an `IfcDataStore`'s lazy `getEntity` / `getEntitiesByType` / `getProperties` / `getQuantities` accessors. The fresh-parse worker→main transport path now uses it instead of duplicating the wiring inline.

This fixes a crash when querying a model loaded from the on-disk cache: the cache format only serialises data, so a restored store was missing these accessor methods, and opening the Properties panel for a cached entity threw `store.getEntity is not a function` (the viewer's cache-restore path now calls `attachDataStoreAccessors`).
