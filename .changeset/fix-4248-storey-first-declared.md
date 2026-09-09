---
"@ifc-lite/parser": patch
---

Fix `SpatialHierarchyBuilder.elementToStorey` disagreeing with `packages/query`'s `EntityNode.containedIn()` on which storey an element is on when a malformed file names the same element in more than one `IfcRelContainedInSpatialStructure` edge (from different storeys). `elementToStorey` unconditionally overwrote its map entry while walking storeys in build order, so the answer depended on storey traversal order rather than file declaration order. It now resolves the same way `containedIn()` already does — first-declared wins, read directly off the element's inverse `ContainsElements` edge order — independent of which storey the tree walk reaches first or last.
