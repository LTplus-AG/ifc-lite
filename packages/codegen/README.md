# @ifc-lite/codegen

TypeScript code generator for IFC EXPRESS schemas. Parses official `.exp` schema files from buildingSMART and emits typed TypeScript: one interface per entity (776 for IFC4, 876 for IFC4X3) with full inheritance, schema metadata for runtime introspection, and exhaustive enum unions.

The generator itself is a build-time tool. The package also ships pre-generated bundles as subpath exports: `@ifc-lite/codegen/ifc2x3`, `@ifc-lite/codegen/ifc4` and `@ifc-lite/codegen/ifc4x3` (entity interfaces, enums, schema registry, type ids, serializers), plus `@ifc-lite/codegen/schema-hierarchy` (`isSubtypeOf`, `isSubtypeOfAny`, `isProperSubtypeOf`, `isProperSubtypeOfAny`). `@ifc-lite/export` and `@ifc-lite/ids` import `schema-hierarchy` at runtime; `@ifc-lite/parser` ships its own generated copy.

## Installation

```bash
npm install --save-dev @ifc-lite/codegen
```

## Generate from the official IFC schema

The package has no `bin`; run its CLI with Node. The paths below are relative to the package directory (`node_modules/@ifc-lite/codegen` after an install, `packages/codegen` in the repository), which also holds the bundled `schemas/`.

```bash
# IFC4 (776 entities)
node dist/cli.js schemas/IFC4_ADD2_TC1.exp --output ./generated/ifc4

# IFC4X3 (876 entities, includes infrastructure: roads, bridges, alignments)
node dist/cli.js schemas/IFC4X3.exp --output ./generated/ifc4x3

# IFC2X3 (653 entities)
node dist/cli.js schemas/IFC2X3_TC1.exp --output ./generated/ifc2x3
```

Pass `--rust` to also emit Rust type tables (consumed by the ifc-lite Rust core).
Rust output is public by default. Add `--rust-crate-private` when the generated
registry is an implementation detail of one crate and must use `pub(crate)`
instead of becoming part of that crate's public API; the flag has no effect
unless `--rust` is also present. To generate
one exact-name universe across supported releases while keeping the first schema authoritative
for attributes, pass older schemas with `--rust-supplemental-schema`. Rust generation (except with `--rust-crate-private`) also
includes class-shaped rows from `@ifc-lite/data`'s IFC4 family catalog, covering accepted IFC4X1
entities such as `IfcAlignmentCurve` that are absent from the bundled IFC4 ADD2 EXPRESS file:

```bash
node dist/cli.js schemas/IFC4X3.exp --rust \
  --rust-supplemental-schema schemas/IFC4_ADD2_TC1.exp schemas/IFC2X3_TC1.exp
```

To also emit the typed attribute slots (`slots.rs`, consumed as `ifc_lite_core::slot`), pass
every other bundled release with `--rust-slot-schema` and the same-position rename table with
`--rust-slot-renames`. Slots are named by the canonical attribute name, stable positions become
`Slot<Kind>` consts and positions that move between releases become `SchemaSlot<Kind>`; every
row of `schemas/attribute-renames.json` is validated against the schemas and a rename whose names
sit at different positions fails generation. `scripts/check-codegen-sync.mjs` regenerates the
committed file:

```bash
node dist/cli.js schemas/IFC4X3.exp --rust \
  --rust-supplemental-schema schemas/IFC4_ADD2_TC1.exp schemas/IFC2X3_TC1.exp \
  --rust-slot-schema schemas/IFC2X3_TC1.exp schemas/IFC4_ADD2_TC1.exp schemas/IFC4X1.exp schemas/IFC4X2.exp \
  --rust-slot-renames schemas/attribute-renames.json
```

Generated files (one per output directory, e.g. `./generated/ifc4`):

```text
generated/ifc4/
├── entities.ts          ← TypeScript interfaces for every entity
├── types.ts             ← defined-type aliases
├── enums.ts             ← enum definitions
├── selects.ts           ← SELECT union types
├── schema-registry.ts   ← runtime metadata (parent, attributes, ...)
├── type-ids.ts          ← numeric type-id lookup tables
├── serializers.ts       ← STEP serializer bound to the schema registry
├── test-compile.ts      ← compile smoke test (excluded from the published build)
└── index.ts             ← barrel export
```

## Programmatic usage

```typescript
import { parseExpressSchema, generateTypeScript } from '@ifc-lite/codegen';
import { readFile, writeFile } from 'node:fs/promises';

// The bundled schemas ship in the package: node_modules/@ifc-lite/codegen/schemas/
const schema = parseExpressSchema(
  await readFile('./node_modules/@ifc-lite/codegen/schemas/IFC4_ADD2_TC1.exp', 'utf-8'),
);

console.log(`Parsed ${schema.entities.length} entities, ${schema.types.length} types`);

const generated = generateTypeScript(schema);

await writeFile('./generated/ifc4/entities.ts', generated.entities);
await writeFile('./generated/ifc4/schema-registry.ts', generated.schemaRegistry);
```

## What you get

For an EXPRESS entity like:

```express
ENTITY IfcWall
  SUBTYPE OF (IfcBuildingElement);
  PredefinedType : OPTIONAL IfcWallTypeEnum;
END_ENTITY;
```

You get a TypeScript interface with full inheritance:

<!-- Reason: shows generator OUTPUT; IfcBuildingElement and IfcWallTypeEnum only exist in the emitted files. -->
<!-- docs-check: skip -->
```typescript
export interface IfcWall extends IfcBuildingElement {
  PredefinedType?: IfcWallTypeEnum;
}
```

Plus runtime metadata for the same entity:

<!-- Reason: shows generator OUTPUT; SCHEMA_REGISTRY lives in the emitted schema-registry.ts. -->
<!-- docs-check: skip -->
```typescript
SCHEMA_REGISTRY.entities.IfcWall = {
  name: 'IfcWall',
  isAbstract: false,
  parent: 'IfcBuildingElement',
  inheritanceChain: ['IfcRoot', 'IfcObjectDefinition', /* ... */, 'IfcWall'],
  attributes: [
    { name: 'PredefinedType', type: 'IfcWallTypeEnum', optional: true, isArray: false, isList: false, isSet: false },
  ],
  allAttributes: [/* every inherited attribute, in inheritance order */],
};
```

## Why generate vs. hand-write

- **Coverage:** 776 IFC4 entities and 876 IFC4X3 entities, all generated.
- **Updates:** when buildingSMART releases a new schema, regenerate; no manual edits.
- **Consistency:** every entity follows the same shape. Types, names, optional-ness all match the spec exactly.
- **Type safety:** TypeScript catches schema-violating attribute access at compile time.

## API

See the [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-litecodegen).

## License

[MPL-2.0](../../LICENSE)
