---
'@ifc-lite/data': minor
---

Add per-IFC-version schema lookup tables generated from
buildingSMART/IDS-Audit-tool's `SchemaInfo.*.g.cs` source files (MIT).
Covers IFC2X3, IFC4 and IFC4X3 (with `IFC4X3_ADD2` aliased to IFC4X3).

Totals: **2711 entities, 1485 property sets, 7624 properties, 390 IFC
data types, 2765 attribute rows, 18 partOf relations**.

New helpers:
- `getEntities(version)` → entity table (name, parent, abstract,
  predefined types, attributes, source schema, type-entity).
- `getPropertySets(version)` → pset table (name, applicableEntities,
  properties with `kind` ∈ {single, enumeration, list, bounded,
  reference} + dataType / enumeration values).
- `getPartOfRelations(version)` → IfcRel* table (relation, owner,
  member).
- `getDataTypes(version)` → IFC dataType → backing XSD type
  (e.g. `IFCLABEL → xs:string`, `IFCREAL → xs:double`).
- `getAttributes(version)` → attribute → simple-value-allowed entities
  vs complex/entity-typed entities.
- `findEntity` / `findPropertySet` / `findDataType` / `findAttribute`
  for case-insensitive lookups.
- `getInheritanceChain(version, name)` walks the EXPRESS chain.
- `isEntitySubtypeOf(version, entity, target)` does subtype tests.
- `RESERVED_PSET_PREFIXES` constant — `Pset_` and `Qto_`.

Generator script: `packages/data/scripts/generate-ifc-schema.ts`,
invokable via `pnpm --filter @ifc-lite/data run generate:ifc-schema`.
The vendored upstream C# source files and the upstream MIT license live
in `scripts/upstream/` so the generator can run offline; the README in
that directory documents the update workflow.

The async API contract is intentional: even though the seed tables are
bundled JS modules today, future implementations may dynamically import
multi-MB JSON dumps without a breaking change.

This is consumed by `@ifc-lite/ids`'s new `auditIDSDocument`, but the
helpers are general-purpose — any consumer that needs case-insensitive
entity/pset lookup, EXPRESS inheritance chains, or subtype tests can
use them.
