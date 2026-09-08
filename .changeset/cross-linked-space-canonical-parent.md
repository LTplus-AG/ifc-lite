---
"@ifc-lite/parser": patch
---

Fix `SpatialHierarchyBuilder` building a different spatial hierarchy depending on relationship-traversal order when a space (or spatial zone) is both aggregated under one spatial container via `IfcRelAggregates` and merely contained under a different one via `IfcRelContainedInSpatialStructure` - a malformed but real cross-linked authoring-tool export.

Previously the builder deduped a spatial child only through a global DFS `visited` set, so whichever parent was visited first won the real node while the other received an empty stub - AND that other parent's `children` still listed the id, a dangling reference to a node that lived elsewhere in the tree. The same file loaded fresh vs. from cache, or with its relationships listed in a different order, could therefore produce two disagreeing hierarchies.

The builder now resolves each spatial child's ONE canonical parent globally, before recursion starts: aggregation always wins over containment, and a tie between multiple edges of the same kind resolves to the lowest `IfcRelAggregates`/`IfcRelContainedInSpatialStructure` express id. A losing parent no longer builds or lists the child at all. This mirrors the Rust server's `canonical_parent` pass (`apps/server/src/services/data_model/spatial.rs`, introduced there for the single-parent case).

`computeCanonicalParent` was split into `packages/parser/src/spatial-hierarchy-canonical-parent.ts` to keep `spatial-hierarchy-builder.ts` under the repo's module-size budget.
