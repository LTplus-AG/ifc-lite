# @ifc-lite/codegen

TypeScript code generator for IFC EXPRESS schemas. Parses official `.exp` schema files from buildingSMART and emits typed TypeScript: 1000+ entity interfaces with full inheritance, schema metadata for runtime introspection, and exhaustive enum unions.

This is a build-time tool — you don't depend on it at runtime. The generated output ships with `@ifc-lite/parser`.

## Installation

```bash
npm install --save-dev @ifc-lite/codegen
```

## Generate from the official IFC schema

```bash
# IFC4 (776 entities)
node dist/cli.js schemas/IFC4_ADD2_TC1.exp --output ./generated/ifc4

# IFC4X3 (876 entities, includes infrastructure: roads, bridges, alignments)
node dist/cli.js schemas/IFC4X3.exp --output ./generated/ifc4x3
```

Pass `--rust` to also emit Rust type tables (consumed by the ifc-lite Rust core).

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
└── index.ts             ← barrel export
```

## Programmatic usage

```typescript
import { parseExpressSchema, generateTypeScript } from '@ifc-lite/codegen';
import { readFile, writeFile } from 'node:fs/promises';

const schema = parseExpressSchema(await readFile('./schemas/IFC4.exp', 'utf-8'));

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

```typescript
export interface IfcWall extends IfcBuildingElement {
  PredefinedType?: IfcWallTypeEnum;
}
```

Plus runtime metadata for the same entity:

```typescript
SCHEMA_REGISTRY.IfcWall = {
  parent: 'IfcBuildingElement',
  inheritanceChain: ['IfcRoot', 'IfcObjectDefinition', /* ... */, 'IfcWall'],
  attributes: [
    { name: 'PredefinedType', type: 'IfcWallTypeEnum', optional: true },
  ],
  allAttributes: [/* every inherited attribute, in inheritance order */],
};
```

## Why generate vs. hand-write

- **Coverage:** 776 IFC4 entities and 876 IFC4X3 entities — manual implementation gets ~7% there.
- **Updates:** when buildingSMART releases a new schema, regenerate; no manual edits.
- **Consistency:** every entity follows the same shape. Types, names, optional-ness all match the spec exactly.
- **Type safety:** TypeScript catches schema-violating attribute access at compile time.

## API

See the [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-litecodegen).

## License

[MPL-2.0](../../LICENSE)
