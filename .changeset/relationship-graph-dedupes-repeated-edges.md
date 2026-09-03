---
'@ifc-lite/data': patch
'@ifc-lite/parser': patch
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
---

Fix `RelationshipGraphBuilder.addEdge` double-counting a relationship that a file declares twice.

Nothing in EXPRESS forbids two `IfcRel*` instances from naming the same (relating, related) pair — two `IfcRelContainedInSpatialStructure` records can re-relate the same element to the same storey, and `IfcRelDefinesByProperties` carries only a `NoRelatedTypeObject` WHERE rule. The builder pushed both edges, so every consumer that walks the raw edge list saw the target twice: `store.spatialHierarchy.byStorey` listed the element twice, the viewer's generated schedule reported one product too many, and `SpatialHierarchy.parquet` emitted a duplicate row (which a `GROUP BY` in an external BI tool inherits).

`addEdge` now folds a repeat of a `(source, target, type)` triple into the surviving edge instead of dropping it: the first instance's express id becomes `relationshipId`, later repeats are kept on `shadowedRelationshipIds`. Edges that differ in source, target, or type are untouched. The parser's on-demand property/quantity/classification/document maps — which a query reads in preference to the graph — now dedup the same way, so a redundant `IfcRel*` no longer duplicates a pset, qset, classification, or document either.

Keeping `shadowedRelationshipIds` on the edge matters for delete-then-query: `related()` in both the CLI and MCP backends now treats the connection as alive as long as any one of `relationshipId` or `shadowedRelationshipIds` still exists, so deleting the surviving `IfcRel*` doesn't make the connection vanish while a sibling instance is still in the model.

Two consequences to note:
- `Relationships.parquet` is built from the same graph, so a redundant second `IfcRel*` instance no longer appears there as its own row. The table reports the distinct relationships in the model rather than one row per source `IfcRel*` record.
- The on-disk model cache (`@ifc-lite/cache`) does not persist `shadowedRelationshipIds`. A model loaded from cache falls back to the pre-fix delete behavior for this specific case (delete the surviving `IfcRel*` of a duplicated pair) until the cache is invalidated and the model re-parsed. Tracked separately; not fixed in this patch.
