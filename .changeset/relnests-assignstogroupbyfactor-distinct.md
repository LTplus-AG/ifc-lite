---
"@ifc-lite/data": patch
"@ifc-lite/parser": patch
"@ifc-lite/export": patch
"@ifc-lite/cache": patch
---

Fix two of the relationship-graph folds named in #4205 that lost information at parse time:

- `IfcRelNests` was indexed onto the exact same `RelationshipType.Aggregates` edge as `IfcRelAggregates`, with no way to tell a nesting edge apart from a real decomposition edge once indexed. It now also lands on a distinct `RelationshipType.Nests` edge (in addition to the existing `Aggregates` edge, so every current consumer — spatial hierarchy, decomposition, the IDS `partOf`/ancestors bridge — is unaffected).
- `IfcRelAssignsToGroupByFactor` was indexed onto the same `RelationshipType.AssignsToGroup` edge as a plain `IfcRelAssignsToGroup`, and its `Factor` attribute was unreachable from the relationship graph. It now also lands on a distinct `RelationshipType.AssignsToGroupByFactor` edge, and `extractGroupAssignmentFactorOnDemand(store, groupId, memberId)` resolves the `Factor` value (`undefined`, not `0`, when the assignment is plain or absent).

This is a narrow fix for the two folds the issue calls out as live defects, not the full schema-derived relationship-edge migration #4205 also scopes — the hand-written 17-value `RelationshipType` enum and the hand-written relating/related attribute slots are unchanged.
