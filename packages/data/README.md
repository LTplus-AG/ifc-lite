# @ifc-lite/data

Columnar data structures for IFClite. TypedArray-backed storage for entities, properties, quantities, and relationships — the layout that lets `@ifc-lite/parser` hold a 200 MB IFC file in ~30 MB of RAM and lets `@ifc-lite/query` filter it in milliseconds.

## Installation

```bash
npm install @ifc-lite/data
```

## When to use this directly

Most users get these structures for free as the output of `@ifc-lite/parser`'s `parseColumnar()`. Use this package directly when you're:

- Building a custom data source (e.g. server-side parquet → IFClite tables)
- Writing a tool that consumes the columnar format outside the parser pipeline
- Looking up EPSG codes (the geo-reference index is shipped here)

## Build an entity table

```typescript
import { EntityTableBuilder, StringTableBuilder } from '@ifc-lite/data';

const strings = new StringTableBuilder();
const entities = new EntityTableBuilder();

const wallTypeId = strings.intern('IFCWALL');
const wallNameId = strings.intern('Wall A');
const wallGuidId = strings.intern('1abc2def3...');

entities.add({
  expressId: 42,
  typeNameId: wallTypeId,
  nameId: wallNameId,
  globalIdId: wallGuidId,
  // ... other columns
});

const table = entities.build();
const stringTable = strings.build();

console.log(table.count);                       // 1
console.log(stringTable.get(table.name[0]));    // 'Wall A'
console.log(table.getTypeName(42));             // 'IFCWALL'
```

## Relationship graph

Edges are stored CSR-style (compressed sparse row) — fast to traverse, compact in memory.

```typescript
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';

const builder = new RelationshipGraphBuilder();

// Storey 100 contains walls 42, 43, 44
builder.addEdge(100, 42, RelationshipType.CONTAINS);
builder.addEdge(100, 43, RelationshipType.CONTAINS);
builder.addEdge(100, 44, RelationshipType.CONTAINS);

const graph = builder.build();

const contained = graph.outgoing(100, RelationshipType.CONTAINS);
console.log([...contained]); // [42, 43, 44]
```

## EPSG lookup

The full EPSG database ships as a pre-built index — geo-referenced models can resolve coordinate systems offline at runtime.

```typescript
import { lookupEpsgByCode, searchEpsgIndex } from '@ifc-lite/data';

const lv95 = await lookupEpsgByCode(2056);
// { code: 2056, name: 'CH1903+ / LV95', kind: 'projected', ... }

const matches = await searchEpsgIndex('web mercator');
// → top text-search results; ordered by relevance
console.log(matches.map(m => `${m.code} ${m.name}`));
```

The index is generated at build time and committed to the repo, so normal builds stay offline. Refresh it with `pnpm generate:epsg-index`.

## API

See the [API Reference](../../docs/api/typescript.md#ifc-litedata).

## License

[MPL-2.0](../../LICENSE)
