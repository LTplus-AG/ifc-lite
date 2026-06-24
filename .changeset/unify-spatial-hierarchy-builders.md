---
"@ifc-lite/parser": minor
---

`SpatialHierarchyBuilder` is now the single source for spatial-hierarchy construction. Added `buildFromCache(entities, relationships)` for cache restores (no source buffer, so storey elevations stay empty and `getStoreyByElevation` returns null), alongside the existing `build(...)` for fresh parses. Both entry points share one `buildNode`, so they can no longer drift: the fresh path now also applies the aggregate-descendant storey mapping (an `IfcBuildingElementPart` under an `IfcWall` resolves to that wall's storey), and the cache path now also has the cyclic-`IfcRelAggregates` guard. The viewer's duplicate `rebuildSpatialHierarchy` becomes a thin wrapper over `buildFromCache`.
