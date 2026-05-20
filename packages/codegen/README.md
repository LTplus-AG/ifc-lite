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
npx ifc-lite-codegen ./schemas/IFC4.exp --out ./src/generated

# IFC4X3 (876 entities, includes infrastructure: roads, bridges, alignments)
npx ifc-lite-codegen ./schemas/IFC4X3.exp --out ./src/generated
```

Generated files (one per output directory):

```
src/generated/
├── entities.ts          ← TypeScript interfaces for every entity
├── schema-registry.ts   ← runtime metadata (parent, attributes, ...)
├── types.ts             ← enum unions and SELECT types
└── index.ts             ← barrel export
```

## Programmatic usage

```typescript
import { parseExpressSchema, generateTypeScript } from '@ifc-lite/codegen';
import { writeFile } from 'node:fs/promises';

const schema = parseExpressSchema('./schemas/IFC4.exp');

console.log(`Parsed ${schema.entities.length} entities, ${schema.types.length} types`);

const generated = generateTypeScript(schema, {
  inheritanceChain: true,
  emitEnums: true,
});

await writeFile('./src/generated/entities.ts', generated.entities);
await writeFile('./src/generated/schema-registry.ts', generated.schemaRegistry);
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

See the [API Reference](https://ltplus-ag.github.io/ifc-lite/api/typescript/#ifc-litecodegen).

## License

[MPL-2.0](../../LICENSE)
