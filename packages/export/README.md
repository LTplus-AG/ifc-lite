# @ifc-lite/export

Export formats for IFClite. Writes Apache Parquet (Arrow-based internally), IFC STEP (with mutations applied), IFC5 IFCX (JSON + USD geometry), and lightweight LOD0/LOD1 envelopes — all from a single parsed `IfcDataStore`.

> **glTF/GLB, CSV and JSON-LD moved to Rust.** They are now assembled by the `ifc-lite-export` crate and reached through `GeometryProcessor` in [`@ifc-lite/geometry`](../geometry); the standalone `GLTFExporter`/`CSVExporter`/`JSONLDExporter` classes were retired.

## Installation

```bash
npm install @ifc-lite/export
```

## glTF / GLB — for the web

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const gp = new GeometryProcessor();
await gp.init();

// From already-produced meshes (no re-mesh) …
const glb = gp.exportGlbFromMeshes(result.meshes, /* includeMetadata */ true);
// … or straight from IFC bytes (meshes internally):
//   gp.exportGlb(bytes, true, new Uint32Array(), new Uint32Array(), '')

// Download
const url = URL.createObjectURL(new Blob([new Uint8Array(glb)], { type: 'model/gltf-binary' }));
```

## CSV / JSON-LD / HBJSON - also via GeometryProcessor

```typescript
// `file` is a caller-provided File (e.g. from an <input type="file">)
const bytes = new Uint8Array(await file.arrayBuffer()); // raw IFC bytes

// CSV: mode is one of entities | properties | quantities | spatial
const csv = gp.exportCsv(bytes, 'properties');

// JSON-LD knowledge graph
const jsonld = gp.exportJsonld(bytes);

// HBJSON (Honeybee JSON for energy simulation)
const hbjson = gp.exportHbjson(bytes, 'model');
// Each returns Uint8Array | null (null until the processor is initialized)
```

## IFC STEP — with mutations

```typescript
import { exportToStep } from '@ifc-lite/export';

const stepText = exportToStep(store, {
  schema: 'IFC4',           // 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5'
  applyMutations: true,     // include edits from MutablePropertyView
  visibleOnly: false,       // export only entities visible in the renderer
});

// Save as .ifc
const blob = new Blob([stepText], { type: 'application/x-step' });
```

`exportToStep` is the round-trip path for property edits. Edit via `@ifc-lite/mutations`, export with `applyMutations: true`, ship the resulting `.ifc` to whatever consumes IFC.

## Apache Parquet — for analytics

```typescript
import { ParquetExporter } from '@ifc-lite/export';

const exporter = new ParquetExporter(store);

// One .bos archive (ZIP of Parquet tables: entities, properties, quantities, …)
const bos = await exporter.exportBOS();

// …or a single table on its own
//   tableName ∈ entities|properties|quantities|relationships|strings|vertices|indices|meshes
const entities = await exporter.exportTable('entities');

// Each Parquet table is ~15–50× smaller than equivalent JSON
// Loadable directly from DuckDB, Polars, pandas, BigQuery, …
```

## IFC5 IFCX — JSON + USD geometry

```typescript
import { Ifc5Exporter } from '@ifc-lite/export';

const exporter = new Ifc5Exporter(store, geometryResult, mutationView);

const result = exporter.export({
  includeGeometry: true,    // tessellated meshes as USD
  includeProperties: true,  // psets in bsi::ifc::prop:: namespace
  applyMutations: true,
  visibleOnly: false,
});

// result.content → IFCX JSON string
// result.stats   → { nodeCount, propertyCount, meshCount, fileSize }
```

Cross-schema conversion happens automatically — feed an IFC2X3 store, get IFC5 output.

## LOD0 / LOD1 — lightweight previews

Generate cheap geometric envelopes for use in dashboards, list views, or first-paint hints. Environment-agnostic (Node, browser, server) — accepts raw IFC bytes:

```typescript
import { generateLod0, generateLod1 } from '@ifc-lite/export';

const bytes = new Uint8Array(await file.arrayBuffer());

// LOD0 — bounding boxes + transforms per element, JSON
const lod0 = await generateLod0(bytes);

// LOD1 — meshes simplified to bounding boxes / convex hulls, returned as GLB
const lod1 = await generateLod1(bytes, { quality: 'medium' });
//   { glb: Uint8Array, meta: { failedElements, mapping, ... } }

// Falls back gracefully to box geometry if a complex element fails to mesh
```

## Also exported

- `MergedExporter` - merge several parsed models into one STEP export
- `convertEntityType` / `convertStepLine` / `needsConversion` - IFC2X3 / IFC4 / IFC4X3 schema conversion helpers
- `parseGLB` / `parseGLBToMeshData` / `extractGlbMapping` - GLB round-trip readers

## API

See the [Exporting Guide](https://ifclite.dev/docs/guide/exporting/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-liteexport).

## License

[MPL-2.0](../../LICENSE)
