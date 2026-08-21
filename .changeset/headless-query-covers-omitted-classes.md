---
"@ifc-lite/parser": minor
"@ifc-lite/query": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

Stop dropping entities from an unfiltered query, and stop reporting their class as `Unknown`, when the curated `IfcTypeEnum` does not carry it.

**`isProductType` now keys on the inheritance chain.** It gated on `IfcTypeEnumFromString(type) !== Unknown`, and `TYPE_STRING_TO_ENUM` is a curated 138-entry subset — the same table PR #3009 found rejecting standard buildingSMART classes. An unfiltered `bim.query()` walks `store.entityIndex.byType` and keeps only entries this predicate accepts, so every class outside those 138 was absent from the result with nothing to say so. On a 176k-entity MEP model that was every `IfcAirTerminal` (139), every `IfcDuctFitting` (383) and every `IfcDistributionPort` (2,053): 2,575 real elements, reported as not present rather than as unclassified.

The gate is now `isQueryableObjectType` in `@ifc-lite/parser`: `getInheritanceChain(type).includes('IfcObjectDefinition')`, minus `IfcTypeObject` descendants. It lives in the parser rather than in each backend because `isProductType` was a verbatim copy in `packages/cli` and `packages/mcp` and only the CLI copy had tests — a predicate that had just diverged once should not be left in two places to diverge again. Both backends now alias the single implementation and keep publishing it under the old name. That is the exact line the four prefix tests were approximating: `IfcObjectDefinition` covers products, type objects, groups, systems and `IfcContext`, and excludes the other two `IfcRoot` branches, `IfcPropertyDefinition` and `IfcRelationship`. The chain resolves across the bundled schema union, so it answers for classes the pin omits. `IFC_ENTITY_NAMES` alone would not work here: it carries all ~880 classes, so keying on "is a known IFC name" floods the same query with that model's 42,024 `IfcCartesianPoint`.

**Behaviour change worth planning for:** on that model an unfiltered `bim.query()` returns 3,090 entities where it returned 515. The growth is real elements that were missing, and it is dominated by ports on MEP models. Callers that want the narrower set should filter with `byType`.

**`EntityNode.type` no longer answers `Unknown` for an entity the product table does not index.** `store.entities` indexes products, so `getTypeName` has no row for `IfcPropertySet`, `IfcElementQuantity`, `IfcRelDefinesByProperties` or `IfcRelAssociatesMaterial` and answered `'Unknown'` for all four, while `entityIndex.byId` carried the class the whole time as the raw uppercase STEP token. `type` is what callers key passes on, so iterating a model's classes by it skipped 8,928 entities on that same model. It now falls back to the index and canonicalises through `normalizeIfcTypeName`, which resolves against the bundled schema union. `IFC_ENTITY_NAMES` would have been the same curated-subset trap one file over: it is ~880 hand-maintained entries whose generator script no longer exists, so an `IfcMove` on an IFC2X3 model came back as the raw `IFCMOVE` token — a second wrong answer.

`QueryResultEntity.type`, which is what `EntityQuery.execute()` returns, carried the identical getter and is fixed with it. Both now call one `resolveEntityTypeName`; fixing only `EntityNode` would have left the two disagreeing on the same entity.

Verified against the real columnar parser, not only against the query package's mock store. With both changes reverted, 3 of the 5 new CLI tests fail and 1 of the 4 new query tests fails; the two CLI tests that still pass are the ones asserting what stays excluded.
