# @ifc-lite/parser

High-performance IFC parser. Tokenizes STEP files at high throughput, builds columnar TypedArray storage, and ships full type-safe coverage of all 776 IFC4 entities. IFC2X3, IFC4, and IFC4X3 files are detected and parsed at runtime; IFC5 (IFCX) files are handled via `parseAuto`.

## Installation

```bash
npm install @ifc-lite/parser
```

## Parse a file

```typescript
import { IfcParser } from '@ifc-lite/parser';

const parser = new IfcParser();
const buffer = await fetch('model.ifc').then(r => r.arrayBuffer());

const t0 = performance.now();
const store = await parser.parseColumnar(buffer, {
  onProgress: ({ phase, percent }) => console.log(`${phase}: ${percent.toFixed(1)}%`),
});

console.log(`Parsed ${store.entityCount} entities in ${(performance.now() - t0).toFixed(0)}ms`);
```

`parseColumnar()` is the canonical STEP parser. It uses TypedArray-backed storage,
shared scan selection, and on-demand extraction for properties, quantities,
materials, classifications, documents, and attributes.

`extractDocumentsOnDemand(store, expressId, mutationView?)` folds current native
document and association edits with the same positional precedence as STEP export.
Existing normalized document fields keep their casing. Optional target identity and
`unresolved`/`sourceOrigin` distinguish unreadable metadata and immutable forwarded
associations when source bytes are absent; such rows do not prove current membership.

```typescript
const store = await parser.parseColumnar(buffer);

// store.entities    - typed access by expressId
// store.properties  - flattened pset table
// store.quantities  - flattened qset table
// store.spatialHierarchy.byStorey  - Map<storeyId, elementIds[]>
console.log(`${store.entityCount} entities, schema ${store.schemaVersion}`);
```

To handle IFC5 (IFCX) files with the same entry point, use `parseAuto`:

```typescript
import { parseAuto } from '@ifc-lite/parser';

const result = await parseAuto(buffer);
// result.format is 'ifc' (STEP -> IfcDataStore) or 'ifcx' (JSON -> IfcxParseResult + meshes)
```

## Type-safe entity access

All 776 IFC4 entities ship as TypeScript types via the generated schema.

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
// Pass a native mutation view to read current classification edits before export.
// const currentClassifications = extractClassificationsOnDemand(store, wallId, mutationView);
//   [{ system: 'Uniclass 2015', identification: 'Pr_60_10_32', name: 'External walls', ... }]
```

## Georeferencing

```typescript
import { extractGeoreferencingOnDemand } from '@ifc-lite/parser';

const georef = extractGeoreferencingOnDemand(store);

if (georef?.hasGeoreference) {
  console.log(`CRS: ${georef.projectedCRS?.name}`);
  console.log(`Origin: ${georef.mapConversion?.eastings}, ${georef.mapConversion?.northings}, ${georef.mapConversion?.orthogonalHeight}`);
  console.log(`Grid north: ${georef.mapConversion?.xAxisAbscissa}, ${georef.mapConversion?.xAxisOrdinate}`);
}
```

The exported, immutable `SI_PREFIX_MULTIPLIERS` table maps the exact `IfcSIPrefix`
enumeration names to their numeric prefix factors. IFC readers and STEP compatibility writers
share this table; an unknown prefix must be refused rather than treated as 1.

## Read cost data

```typescript
import { evaluateCostItem, extractCostOnDemand } from '@ifc-lite/parser';

const cost = extractCostOnDemand(store);
const result = evaluateCostItem(cost, cost.CostItems[0].expressId);
console.log(result.Amount, result.Currency, result.Diagnostics);
```

The read model preserves ordered `CostValues`, direct `CostQuantities`, shared
references, and the original `IfcRelNests`/assignment relationship endpoints.
Rates use only `IfcCostItem.CostQuantities`; product Qto values are never used as
an implicit fallback. Direct quantities make the item's values unit costs even
when `UnitBasis` is absent. IFC4 and IFC4X3 support exact-decimal arithmetic,
currencies, compatible `UnitBasis` conversion, and named or `*` nested-category
totals. Invalid quantities or incompatible dimensions produce diagnostics and
withhold the total instead of returning a partial result. IFC2X3 cost metadata and legacy
relationships remain inspectable, with an explicit partial-read diagnostic;
IFC2X3 evaluation is intentionally unsupported.

## Performance

| Model size | Parse time |
|---:|---:|
| 10 MB | ~100–200 ms |
| 50 MB | ~600–700 ms |
| 200 MB | ~2.5–3 s |

- Tokenization: high single-pass throughput on M1/M2 laptops
- Bundle: ~200 KB gzipped (schema registry included)
- Memory: TypedArray columnar storage

## API

See the [Parsing Guide](https://ifclite.dev/docs/guide/parsing/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-liteparser).

## License

[MPL-2.0](../../LICENSE)
