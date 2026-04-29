# @ifc-lite/parser

High-performance IFC parser. Tokenizes STEP files at ~1,259 MB/s, builds columnar TypedArray storage, and ships full type-safe coverage of IFC4 (776 entities) and IFC4X3 (876 entities).

## Installation

```bash
npm install @ifc-lite/parser
```

## Parse a file

```typescript
import { IfcParser } from '@ifc-lite/parser';

const parser = new IfcParser();
const buffer = await fetch('model.ifc').then(r => r.arrayBuffer());

const result = await parser.parse(buffer, {
  onProgress: ({ phase, percent }) => console.log(`${phase}: ${percent.toFixed(1)}%`),
});

console.log(`Parsed ${result.entityCount} entities in ${result.parseTime}ms`);
```

For columnar storage (TypedArray-backed, query-friendly, recommended for models > 10 MB):

```typescript
const store = await parser.parseColumnar(buffer);

// store.entities    — typed access by expressId
// store.properties  — flattened pset table
// store.quantities  — flattened qset table
// store.spatialHierarchy.byStorey  — Map<storeyId, Set<elementId>>
console.log(`${store.entityCount} entities, schema ${store.schemaVersion}`);
```

## Type-safe entity access

All 776 IFC4 entities (876 for IFC4X3) ship as TypeScript types via the generated schema.

```typescript
import type { IfcWall, IfcDoor, IfcSlab } from '@ifc-lite/parser';
import { isKnownEntity, getEntityMetadata } from '@ifc-lite/parser';

// Schema metadata
const meta = getEntityMetadata('IfcWall');
console.log(meta.parent);              // 'IfcBuildingElement'
console.log(meta.inheritanceChain);    // ['IfcRoot', ..., 'IfcWall']
console.log(meta.allAttributes);       // every attribute including inherited

// Schema membership check
console.log(isKnownEntity('IfcWall'));     // true
console.log(isKnownEntity('IfcWidget'));   // false
```

## On-demand property extraction

Properties and quantities are extracted lazily — pay only for what you read.

```typescript
import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractMaterialsOnDemand,
  extractClassificationsOnDemand,
} from '@ifc-lite/parser';

const wallId = 12345;

const psets = extractPropertiesOnDemand(store, wallId);
//   [{ name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI 60' }, ...] }]

const qsets = extractQuantitiesOnDemand(store, wallId);
//   [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 5.0 }, ...] }]

const material = extractMaterialsOnDemand(store, wallId);
//   { name: 'Concrete C30/37', layers: [{ name: 'Concrete', thickness: 0.15 }, ...] }

const classifications = extractClassificationsOnDemand(store, wallId);
//   [{ system: 'Uniclass 2015', code: 'Pr_60_10_32', name: 'External walls', ... }]
```

## Georeferencing

```typescript
import { extractGeoreferencingOnDemand } from '@ifc-lite/parser';

const georef = extractGeoreferencingOnDemand(store);

if (georef?.hasGeoreference) {
  console.log(`CRS: ${georef.projectedCRS?.name}`);
  console.log(`Origin: ${georef.eastings}, ${georef.northings}, ${georef.orthogonalHeight}`);
  console.log(`Rotation: ${georef.rotationRadians} rad`);
}
```

## Performance

| Model size | Parse time |
|---:|---:|
| 10 MB | ~100–200 ms |
| 50 MB | ~600–700 ms |
| 200 MB | ~2.5–3 s |

- Tokenization: ~1,259 MB/s on M1/M2 laptops
- Bundle: ~200 KB gzipped (schema registry included)
- Memory: TypedArray columnar storage

## API

See the [Parsing Guide](../../docs/guide/parsing.md) and [API Reference](../../docs/api/typescript.md#ifc-liteparser).

## License

[MPL-2.0](../../LICENSE)
