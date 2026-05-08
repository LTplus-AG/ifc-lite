---
'@ifc-lite/data': minor
---

Add per-IFC-version schema lookup tables: `getEntities`, `getPropertySets`,
`getPartOfRelations`, `findEntity`, `findPropertySet`,
`getInheritanceChain`, `isEntitySubtypeOf`, plus the `RESERVED_PSET_PREFIXES`
constant and the supporting `IfcEntityInfo`, `IfcPropertyInfo`,
`IfcPropertySetInfo`, `PartOfRelationInfo`, `IfcSchemaVersion` types.

The dataset covers IFC2X3, IFC4 and IFC4X3 (with `IFC4X3_ADD2` aliased to
IFC4X3) — 2711 entities, 1485 property sets and 7624 properties total —
generated from buildingSMART/IDS-Audit-tool's `SchemaInfo.*.g.cs` source
files (MIT-licensed). The generator script lives at
`packages/data/scripts/generate-ifc-schema.ts` and is invokable via
`pnpm --filter @ifc-lite/data run generate:ifc-schema`. The vendored C#
files and their MIT license live in `scripts/upstream/`.

The async API contract is intentional: even though the seed tables are
bundled JS modules today, future implementations may dynamically import
multi-MB JSON dumps without a breaking change.

This is consumed by `@ifc-lite/ids`'s new `auditIDSDocument` for
entity/predefined-type / pset / property / attribute / partOf cross-checks,
but the helpers are general — any consumer that needs case-insensitive
entity/pset lookup, EXPRESS inheritance chains or subtype tests can use them.
