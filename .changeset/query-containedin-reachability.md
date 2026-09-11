---
"@ifc-lite/query": patch
---

Fix `EntityNode.containedIn()` returning an unreachable spatial container when an element is duplicate-declared in more than one `IfcRelContainedInSpatialStructure` edge (a malformed file naming the same element from two different storeys) and the first-declared storey is itself an orphan with no `IfcRelAggregates` edge back to `IfcProject` at all. `containedIn()` previously always took the first-declared candidate (`#4311`'s tie-break), so this exact shape returned a container no caller can walk anywhere from. It now prefers the first-declared candidate that is reachable from `IfcProject` by walking `decomposedBy()` parents, falling through to a reachable later-declared one, and only falls back to the first-declared candidate when none are reachable.
