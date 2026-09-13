---
"@ifc-lite/data": minor
"@ifc-lite/parser": patch
"@ifc-lite/export": patch
"@ifc-lite/cache": patch
"@ifc-lite/query": patch
---

`extractRelFast`'s hand-written per-STEP-keyword branch ladder (`packages/parser/src/columnar-parser-relationships.ts`) is replaced by a single schema-derived algorithm: for any `IfcRelationship` subtype, the relating (single-reference) and related (reference-or-list) attribute positions are read straight from the codegen-generated schema registries, keyed by the `Relating*`/`Related*` EXPRESS naming convention, not a hand-typed table. `HIERARCHY_REL_TYPES` (the gate that decides which STEP keywords ever reach relationship extraction) is derived the same way, from every concrete `IfcRelationship` subtype across the bundled IFC2X3/IFC4/IFC4X3 registries, replacing an enumeration that #3964, #3237 and #1075 each landed because it was missing one more class.

17 previously wholly-unindexed relationship classes (`IfcRelAssignsToActor`, `IfcRelAssignsToResource`, `IfcRelAssignsToProcess`, `IfcRelAssignsToControl`, `IfcRelAssociatesConstraint`, `IfcRelAssociatesApproval`, `IfcRelAssociatesLibrary`, `IfcRelDeclares`, `IfcRelInterferesElements`, `IfcRelCoversBldgElements`, `IfcRelCoversSpaces`, `IfcRelServicesBuildings`, `IfcRelProjectsElement`, `IfcRelFlowControlElements`, `IfcRelSequence`, and the IFC4X3-only `IfcRelPositions`/`IfcRelAdheresToElement`) each get their own `RelationshipType` enum member and edge, instead of being invisible to the relationship graph. `RelationshipType`-keyed name maps in `relationship-graph.ts`, `parquet-exporter.ts`, `cache/sections/relationships.ts` and `duckdb-integration.ts` were extended for exhaustiveness; the last of those was also converted from a non-exhaustive `Record<number, string>` to `Record<RelationshipType, string>` (it had silently been missing `ConnectsPortToElement`, `ConnectsPorts` and `AssociatesDocument` since they were added).

A handful of concrete relationship subtypes (`IfcRelDefinesByObject`, `IfcRelDefinesByTemplate`, `IfcRelConnectsStructuralActivity`, `IfcRelConnectsStructuralMember`, `IfcRelConnectsWithEccentricity`, `IfcRelConnectsWithRealizingElements`, `IfcRelSpaceBoundary1stLevel`/`2ndLevel`, plus ten IFC2X3-legacy classes such as `IfcRelAssignsTasks`) now pass the schema-derived gate but still have no dedicated `RelationshipType`/edge — a deliberately scoped remainder, not a regression, tracked against #4205.
