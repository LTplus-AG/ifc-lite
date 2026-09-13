---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/query": patch
---

`EntityNode.containedIn()` now resolves duplicate containment against the same reachable-node set `elementToStorey` uses, so the two APIs agree.

When an element is duplicate-declared in more than one `IfcRelContainedInSpatialStructure` edge (a malformed file naming the same element from two different storeys) and the first-declared storey is itself an orphan with no `IfcRelAggregates` edge back to `IfcProject`, `containedIn()` used to return that orphan while `SpatialHierarchyBuilder`'s `elementToStorey` fell through to the reachable, later-declared storey — two APIs answering "which storey is this element on" with a present but different value.

`SpatialHierarchy` gains an optional `reachableSpatialNodes` set, which `SpatialHierarchyBuilder` fills from the `computeReachableSpatialNodes` call it already made when resolving `elementToStorey`, and which survives the worker transport. `containedIn()` reads that set rather than deciding reachability for itself, so the two answers come from one computation and cannot drift. First-declared still wins among reachable containers, and `containedIn()` falls back to the first-declared candidate when no candidate is reachable or the store carries no spatial hierarchy, so a disconnected spatial tree never turns a present answer into `null`.
