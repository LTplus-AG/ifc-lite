# @ifc-lite/export

Export formats for IFClite. Writes glTF/GLB, Apache Parquet, Apache Arrow, IFC STEP (with mutations applied), IFC5 IFCX (JSON + USD geometry), and lightweight LOD0/LOD1 envelopes — all from a single parsed `IfcDataStore`.

## Installation

```bash
npm install @ifc-lite/export
```

## glTF / GLB — for the web

```typescript
import { GLTFExporter } from '@ifc-lite/export';

const exporter = new GLTFExporter();
const glb = await exporter.export(parseResult, {
  format: 'glb',          // 'glb' (binary) or 'gltf' (JSON + .bin)
  includeMaterials: true,
  includeMetadata: true,  // entity types and globalIds in glTF extras
});

// Download
const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
```

## IFC STEP — with mutations

```typescript
import { exportToStep } from '@ifc-lite/export';

const stepText = exportToStep(store, {
  schema: 'IFC4',           // 'IFC2X3' | 'IFC4' | 'IFC4X3'
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

const exporter = new ParquetExporter();
const entities = await exporter.exportEntities(parseResult);
const properties = await exporter.exportProperties(parseResult);
const quantities = await exporter.exportQuantities(parseResult);

// Each is ~15–50× smaller than equivalent JSON
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
//   { glb: Uint8Array, meta: { failedElements, expressIdToNodeId, ... } }

// Falls back gracefully to box geometry if a complex element fails to mesh
```

## API

See the [Exporting Guide](../../docs/guide/exporting.md) and [API Reference](../../docs/api/typescript.md#ifc-liteexport).

## License

[MPL-2.0](../../LICENSE)
