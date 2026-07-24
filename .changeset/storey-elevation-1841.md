---
"@ifc-lite/data": minor
---

Add the canonical storey-elevation definitions (`findStoreyByElevation`, `STOREY_ELEVATION_MATCH_TOLERANCE_M`, `IFC_BUILDING_STOREY_ELEVATION_INDEX`, `IFC_BUILDING_STOREY_PLACEMENT_INDEX`) next to the `SpatialHierarchy` interface they implement, so every path resolves a storey from a Z the same way (issue #1841).

`getStoreyByElevation` had four implementations and three of them disagreed with the fourth: `SpatialHierarchyBuilder` returned `null` beyond a 1m band, while the worker-transport rehydration in `@ifc-lite/parser`, the IFCX hierarchy builder, and the viewer's server-loaded path all snapped to the nearest storey unconditionally. The same Z could therefore resolve to a different storey depending on entry path, and even on which side of the worker boundary the store was read. All four now call the shared resolver; behaviour follows the tolerance-bounded rule.
