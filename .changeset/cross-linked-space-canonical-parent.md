---
"@ifc-lite/parser": patch
---

Fix `SpatialHierarchyBuilder` building a different spatial hierarchy depending on relationship-traversal order when a space (or spatial zone) is both aggregated under one spatial container via `IfcRelAggregates` and merely contained under a different one via `IfcRelContainedInSpatialStructure` - a malformed but real cross-linked authoring-tool export.

Previously the builder deduped a spatial child only through a global DFS `visited` set, so whichever parent was visited first won the real node while the other received an empty stub - AND that other parent's `children` still listed the id, a dangling reference to a node that lived elsewhere in the tree. The same file loaded fresh vs. from cache, or with its relationships listed in a different order, could therefore produce two disagreeing hierarchies.

The builder now resolves each spatial child's ONE canonical parent globally, before recursion starts: aggregation always wins over containment, and a tie between multiple edges of the same kind resolves to whichever `IfcRelAggregates`/`IfcRelContainedInSpatialStructure` was declared FIRST in the file - not the lowest express id, which an earlier version of this fix used as a proxy for declaration order. STEP does not require express ids to ascend with declaration position, so a file that declares a high-id relationship before a low-id one made that proxy disagree with the Rust server's own tie-break. The relationship graph's inverse edge list already preserves declaration order (the parser appends edges while scanning `IfcRel*` records in file order, and the CSR build's counting sort is stable per key), so the first edge in that list is used directly. A losing parent no longer builds or lists the child at all. This mirrors the Rust server's `canonical_parent` pass (`apps/server/src/services/data_model/spatial.rs`), which keeps the first `IfcRelAggregates` it sees while iterating relationships in file-scan order.

`computeCanonicalParent` was split into `packages/parser/src/spatial-hierarchy-canonical-parent.ts` to keep `spatial-hierarchy-builder.ts` under the repo's module-size budget.
