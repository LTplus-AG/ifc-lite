---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/export": patch
"@ifc-lite/cache": patch
"@ifc-lite/query": patch
---

Fix two of the relationship-graph folds named in #4205 that lost information at parse time:

- `IfcRelNests` was indexed onto the exact same `RelationshipType.Aggregates` edge as `IfcRelAggregates`, with no way to tell a nesting edge apart from a real decomposition edge once indexed. It now also lands on a distinct `RelationshipType.Nests` edge (in addition to the existing `Aggregates` edge, so every current consumer — spatial hierarchy, decomposition, the IDS `partOf`/ancestors bridge — is unaffected).
- `IfcRelAssignsToGroupByFactor` was indexed onto the same `RelationshipType.AssignsToGroup` edge as a plain `IfcRelAssignsToGroup`, and its `Factor` attribute was unreachable from the relationship graph. It now also lands on a distinct `RelationshipType.AssignsToGroupByFactor` edge, and `extractGroupAssignmentFactorOnDemand(store, groupId, memberId)` resolves the `Factor` value (`undefined`, not `0`, when the assignment is plain or absent).

This is a narrow fix for the two folds the issue calls out as live defects, not the full schema-derived relationship-edge migration #4205 also scopes — the hand-written 17-value `RelationshipType` enum and the hand-written relating/related attribute slots are unchanged.

Two follow-up fixes for consumers that don't filter by relationship type and so double-counted or mislabeled the new secondary edges:

- `ParquetExporter`'s `Metadata.json` `statistics.relationshipCount` counted raw graph edges, so a model with `IfcRelNests`/`IfcRelAssignsToGroupByFactor` relationships reported one extra per such relationship (the new secondary edge counted alongside its broad-bucket edge). It now counts distinct `IfcRel*` records instead.
- The DuckDB-backed `relationships` SQL table (`@ifc-lite/query`) rendered `rel_type` as `'Unknown'` for both new types — its type→string map was missed when the other three were updated. Added, with the same display strings as those three maps.
