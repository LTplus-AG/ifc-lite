---
"@ifc-lite/parser": patch
"@ifc-lite/ifcx": patch
---

Route `getStoreyByElevation` through the shared `findStoreyByElevation` resolver from `@ifc-lite/data` (issue #1841).

Both packages previously shipped their own always-snap-to-nearest implementations: the worker-transport rehydration in `@ifc-lite/parser` (`data-store-transport.ts`) and the IFCX hierarchy builder (`hierarchy-builder.ts`). Both now apply the same 1m tolerance and deterministic tie-break as the fresh-parse path, so a Z resolves to the same storey regardless of entry path or which side of the worker boundary the store was read from.
