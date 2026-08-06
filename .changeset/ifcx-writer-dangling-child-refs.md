---
"@ifc-lite/ifcx": patch
---

Fix `IfcxWriter` emitting dangling child references in the spatial hierarchy on every plain STEP-IFC → IFCX export.

`collectNodes()` synthesized each entity's own node path via `idToPath?.get(expressId) ?? generatePath(expressId, typeEnum)` (e.g. `ifc:IfcWall.42`), while `getChildrenForEntity()` synthesized the *reference* to that same entity as a child independently, via `idToPath?.get(childId) || 'element:' + childId` (e.g. `element:42`). Whenever `idToPath` was not supplied — which is the normal case; it is only populated on IFCX → IFCX round-trips — the two never agreed, and every emitted `children` entry pointed at a path no node in the file actually had.

The writer now builds a single expressId → path map once while iterating entities in `collectNodes()`, seeded from `idToPath` first (so a child referenced only by id, with no entity row of its own in this file, can still resolve if the caller already knows its path) and filled in with `generatePath()` for every entity. `getChildrenForEntity()` resolves child paths from that same map instead of re-deriving them. A child id with neither an entity row nor an `idToPath` entry is now omitted from `children` rather than emitted as an unresolvable `element:${id}` reference.
