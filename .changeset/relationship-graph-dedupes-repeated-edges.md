---
'@ifc-lite/data': patch
---

Fix `RelationshipGraphBuilder.addEdge` double-counting a relationship that a file declares twice.

Nothing in EXPRESS forbids two `IfcRel*` instances from naming the same (relating, related) pair — two `IfcRelContainedInSpatialStructure` records can re-relate the same element to the same storey, and `IfcRelDefinesByProperties` carries only a `NoRelatedTypeObject` WHERE rule. The builder pushed both edges, so every consumer that walks the raw edge list saw the target twice: `store.spatialHierarchy.byStorey` listed the element twice, the viewer's generated schedule reported one product too many, `SpatialHierarchy.parquet` emitted a duplicate row (which a `GROUP BY` in an external BI tool inherits), and property, quantity, classification and document reads returned the same set twice.

`addEdge` now ignores a repeat of a `(source, target, type)` triple; the first instance wins, so the surviving edge keeps the express id of the first `IfcRel*` that declared it. Edges that differ in source, target, or type are untouched.

One consequence to note: `Relationships.parquet` is built from the same graph, so a redundant second `IfcRel*` instance no longer appears there as its own row. The table reports the distinct relationships in the model rather than one row per source `IfcRel*` record.
