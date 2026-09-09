---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/query": minor
---

Surface ambiguous direct storey containment as a detectable signal (#4311), a follow-up to the first-declared-wins tie-break from #4248/#4310.

An element can be named by more than one `IfcRelContainedInSpatialStructure` edge pointing at different storeys — a malformed-but-real shape both `elementToStorey` and `containedIn()` silently resolved to a single answer, with no way for a caller to tell the containment was contested in the source file.

- `SpatialHierarchy` (`@ifc-lite/data`) gains an optional `ambiguousStorey: Set<number>` field: the element ids whose direct storey containment named more than one distinct storey. `SpatialHierarchyBuilder.build()` / `buildFromCache()` (`@ifc-lite/parser`) always populate it (empty when nothing was ambiguous); it also round-trips through the parser worker transport.
- `EntityNode.containedInAmbiguous()` (`@ifc-lite/query`) answers the same question per-call, for callers using `containedIn()` instead of the parser's aggregate hierarchy.

Neither `elementToStorey`'s nor `containedIn()`'s existing resolution changes — both still return a single winner. Detection reuses the direct-containment lists (`byStorey` / inverse `ContainsElements` edges) each already builds, so it costs no extra graph traversal.
