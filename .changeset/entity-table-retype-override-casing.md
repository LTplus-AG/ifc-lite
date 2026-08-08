---
"@ifc-lite/data": patch
"@ifc-lite/cache": patch
---

Fix `EntityTable.setTypeOverride` storing a UI retype's class name in whatever casing the caller passed instead of canonicalising it.

A "change class" retype hands `setTypeOverride` a raw UPPERCASE IFC class token (e.g. `IFCBUILDINGSTOREY`), and `getTypeName` echoed the override straight back unchanged. `isSpatialStructureTypeName` — and any other case-sensitive `*Name` predicate built off `IfcTypeEnumToString`'s PascalCase output — matches against the PascalCase form only, so a retyped entity's new class silently stopped being recognised as part of the spatial tree, even though the case-insensitive `isStoreyLikeSpatialTypeName` correctly saw it. `setTypeOverride` now canonicalises the incoming name to PascalCase before storing it, so `getTypeName` and every name-based predicate agree regardless of the casing a caller passes in.

`EntityTable` has three independent implementations — the columnar table in `@ifc-lite/data`, the cache-restored table in `@ifc-lite/cache`, and the server-backed table in `apps/viewer` — and all three stored the override verbatim. Fixing only one would have left the same retype behaving differently depending on whether the model came from a fresh parse, a cache restore, or the server, which is harder to diagnose than the original bug. All three now canonicalise identically.
