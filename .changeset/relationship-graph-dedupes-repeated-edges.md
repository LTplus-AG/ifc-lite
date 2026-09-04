---
'@ifc-lite/data': minor
'@ifc-lite/parser': minor
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
'@ifc-lite/cache': minor
'@ifc-lite/export': patch
'@ifc-lite/query': patch
---

Fix `RelationshipGraphBuilder.addEdge` double-counting a relationship that a file declares twice.

Nothing in EXPRESS forbids two `IfcRel*` instances from naming the same (relating, related) pair — two `IfcRelContainedInSpatialStructure` records can re-relate the same element to the same storey, and `IfcRelDefinesByProperties` carries only a `NoRelatedTypeObject` WHERE rule. The builder pushed both edges, so every consumer that walks the raw edge list saw the target twice: `store.spatialHierarchy.byStorey` listed the element twice, the viewer's generated schedule reported one product too many, and `SpatialHierarchy.parquet` emitted a duplicate row (which a `GROUP BY` in an external BI tool inherits).

`addEdge` now folds a repeat of a `(source, target, type)` triple into the surviving edge instead of dropping it: the first instance's express id becomes `relationshipId`, later repeats are kept on `shadowedRelationshipIds`. Edges that differ in source, target, or type are untouched. The parser's on-demand property/quantity/classification/document maps — which a query reads in preference to the graph — now dedup the same way, so a redundant `IfcRel*` no longer duplicates a pset, qset, classification, or document either. `onDemandMaterialMap` is deliberately left as-is: `buildMaterialUsageIndex` already dedupes per (material, entity) downstream via its own `seenPerMaterial` set, a contract pinned by `material-fraction-and-associations.test.ts` (`onDemandMaterialMap.get(100)` for two redundant `IfcRelAssociatesMaterial` records is expected to equal `[300, 300, 999]`, not `[300, 999]`) — deduping upstream too would duplicate that work, not fix a gap.

`shadowedRelationshipIds` is stored on the wire as three small, Transferable typed arrays (`shadowedEdgeIndex`/`shadowedGroupOffsets`/`shadowedRelIds`) rather than one slot per edge, because the obvious dense shape structured-clones (instead of transferring) across the parser worker boundary — measured +1.2s / +190MB on a 12M-edge model for a field that's empty on almost every edge. The fields are optional on `RelationshipEdges`/`RelationshipEdgesColumns`: absent entirely on a graph that tracks no duplicates, read via `?.`.

Four places needed the extra ids, not just the deduped edge itself:
- `related()` in both the CLI and MCP backends now treats a connection as alive as long as any one of `relationshipId` or `shadowedRelationshipIds` still exists (via a shared `edgeSurvives` helper), so deleting the surviving `IfcRel*` doesn't erase a connection a sibling instance still names.
- `getRelationshipsBetween` reports `shadowedRelationshipIds` on each `RelationshipInfo`.
- `Relationships.parquet` and the DuckDB `relationships` table (via a shared `flattenRelationshipEdges` helper) and the anonymized-subset exporter's `collectRelatedEntities` all emit one row/closure entry per shadowed id too, not just the survivor — each is a real STEP record in the source file.
- The on-disk model cache (`@ifc-lite/cache`, FORMAT_VERSION 17 -> 18) persists the shadowed-id columns, so a model reloaded from cache gets the same delete-then-query behavior as a fresh parse. A v17 cache entry (written before this change) is read as having no shadowed ids rather than being treated as corrupt — matches the pre-fix in-memory behaviour exactly, since those graphs never tracked them either — and the cache lookup key already embeds `FORMAT_VERSION`, so an old entry simply misses and re-parses on next load.

`Relationships.parquet` also drops a row whose own `IfcRel*` record has been deleted through the overlay, not only rows whose source or target endpoint was — an `IfcRel*` line is a row in `Entities.parquet` too, so a `RelId` for a deleted one was a dangling reference. Because each shadowed id is its own row, a deleted survivor drops while a live sibling keeps the connection, matching `edgeSurvives`.

One consequence to note: `Relationships.parquet` is still built from the deduped graph, so a redundant second `IfcRel*` instance appears as its own row again (via `shadowedRelationshipIds`) rather than being silently dropped — every `IfcRel*` record that backs a surviving edge appears at least once, including deduplicated duplicates. (Not a 1:1 row-to-record count: a deleted endpoint still drops rows, and one `IfcRel*` with N `RelatedObjects` has always produced N rows, one per target — unchanged by this fix.)
