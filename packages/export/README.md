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
//   gp.exportGlb(bytes, true)
// Leave `isolated` undefined for no isolation filter: an empty Uint32Array
// there is an active allowlist that exports nothing.

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

`GeometryProcessor` also exposes `exportObj`, `exportUsd`, `exportIfcx`, `exportDfjson`, `exportJson`, `exportStep`, `exportMerged`, `exportKmzFromMeshes` and `exportLandXmlTerrain` (see the [`@ifc-lite/geometry` README](../geometry/README.md)).

## IFC STEP — with mutations

```typescript
import { exportToStep, StepExporter } from '@ifc-lite/export';

// The parsed model as it is (schema defaults to the source schema):
const stepText = exportToStep(store, {
  schema: 'IFC4',           // 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5'
  visibleOnly: false,       // export only entities visible in the renderer
});

// With edits: give StepExporter the MutablePropertyView
const result = new StepExporter(store, mutationView).export({
  schema: 'IFC4',
  applyMutations: true,     // default true when a view is supplied
});

// Save as .ifc
const blob = new Blob([new Uint8Array(result.content)], { type: 'application/x-step' });
```

`StepExporter` with a `MutablePropertyView` is the round-trip path for property edits. Edit via `@ifc-lite/mutations`, export as above, ship the resulting `.ifc` to whatever consumes IFC. `exportToStep(store, options)` takes no view, so it writes the parsed model without overlay edits.

## Anonymized isolated export — for bug reports

`collectRelatedEntities` + `exportAnonymizedSubset` pick a seed selection,
expand it by relationship context (host, openings/fillers, type, materials,
spatial containment), and export exactly that subset with every
project-identifying signal removed — while local placement rotations and
non-orthogonal cuts survive, so a parsing/geometry bug reproduction still
reproduces:

```typescript
import { collectRelatedEntities, exportAnonymizedSubset } from '@ifc-lite/export';

const related = collectRelatedEntities(store, new Set([312])); // seed expressId(s)
const result = exportAnonymizedSubset(store, related.all);
await saveFile('anonymized.ifc', result.content);
```

Every `AnonymizeOptions` field defaults to the maximally-scrubbed direction
(names pseudonymized, `GlobalId`s regenerated, property sets dropped, owner
history and georeferencing scrubbed) — `ObjectType` and material/style names
are pseudonymized right along with everything else under the default
`pseudonymizeAllNames`, and the STEP header's `originating_system` is
blanked under the default `scrubOwnerHistory`. What stays in the file by
decision: geometry and local placement rotations/non-orthogonal cuts (only
the root placement's translation is zeroed), structural entity types,
material *assignments* (which material, just not its original name). The
header's `preprocessor_version` is the writer's own, `'ifc-lite'`, not the
source file's. That is what makes the file useful for a bug repro. See the
[Exporting
Guide](https://ifclite.dev/docs/guide/exporting/#anonymized-isolated-export)
for the full option list, including how to opt back into authored names via
`--keep-other-names`.

## Apache Parquet — for analytics

```typescript
import { ParquetExporter } from '@ifc-lite/export';

const exporter = new ParquetExporter(store);

// One .bos archive (ZIP of Parquet tables: entities, properties, quantities, …)
const bos = await exporter.exportBOS();

// …or a single table on its own
//   tableName ∈ entities|properties|quantities|relationships|strings|vertices|indices|meshes
const entities = await exporter.exportTable('entities');

// Parquet is columnar and compressed, so tables are much smaller than JSON
// Loadable directly from DuckDB, Polars, pandas, BigQuery, …
```

Editing via `@ifc-lite/mutations`? Pass the `MutablePropertyView` as the third constructor
argument to drop overlay-deleted entities (and every row that references one) from
the Parquet tables, include overlay-created entities in `Entities.parquet`, and
write the overlay's relationship, property and quantity edits:

```typescript
import { ParquetExporter } from '@ifc-lite/export';

const exporter = new ParquetExporter(store, geometryResult, mutationView);
```

Edits to parsed attribute values (`Name`, `Description`, `ObjectType`; a retype
is applied) and to geometry aren't reflected yet: those columns still copy the
parsed store. `StepExporter`/`Ifc5Exporter` cover the full edit surface today.

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

Generate geometric previews for use in dashboards, list views, or first-paint hints. Environment-agnostic (Node, browser, server) — accepts raw IFC bytes:

```typescript
import { generateLod0, generateLod1 } from '@ifc-lite/export';

const bytes = new Uint8Array(await file.arrayBuffer());

// LOD0 — world bounding box, centroid and transform per element, JSON (no meshing)
const lod0 = await generateLod0(bytes);

// LOD1 — the model's meshes from GeometryProcessor, returned as GLB
const lod1 = await generateLod1(bytes);
//   { glb: Uint8Array, meta: { status, failedElements, mapping, ... } }

// Elements that produce no mesh are listed in meta.failedElements (status 'degraded').
// If meshing fails entirely, the GLB holds the LOD0 boxes (meta.fallback 'boxes_from_lod0').
```

## Also exported

- `StepExporter` - the class behind `exportToStep`; takes an optional `MutablePropertyView`, and `exportAsync` for map-geometry normalization
- `parseStep` / `buildSubset` / `serializeSubset` / `selectSubsetSeeds` - raw STEP subset extraction: copy a few products and their reference closure into a small standalone file
- `DemeshSession` / `applySimplifiedGeometry` - selective mesh simplification with a deferred IFC export
- `analyzeConversionLoss` / `describeConversion` - report what a schema conversion drops or changes
- `columnsToParquet` - write plain columns as one Parquet table
- `MergedExporter` - merge several parsed models into one STEP export (also on its own entry, `@ifc-lite/export/merged-exporter`)
- `exportSectionedStep` - crop a STEP export at half-spaces (see below)
- `exportEnergyArtifact` - a complete STEP model as a Ladybug Tools document
- `tableToCsv` / `escapeCsvCell` / `guardSpreadsheetFormula` - CSV writing with spreadsheet-formula guarding
- `collectRelatedEntities` / `exportAnonymizedSubset` - anonymized isolated export (see above)
- `convertEntityType` / `convertStepLine` / `needsConversion` - IFC2X3 / IFC4 / IFC4X3 schema conversion helpers
- `parseGLB` / `parseGLBToMeshData` / `extractGlbMapping` - GLB round-trip readers

## API

See the [Exporting Guide](https://ifclite.dev/docs/guide/exporting/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-liteexport).

IFCX geometry exports retain texture fragments and owner identity through a
versioned IFClite appearance extension, with bounded shared RGBA pixels and
optional `textureSources` containing original PNG/JPEG bytes. Unresolved images
fail explicitly. This preserves IFClite roundtrips; third-party readers must
implement the extension to recover textures. See
[IFCX texture portability](../../docs/guide/exporting.md#ifcx-texture-portability).

`exportSectionedStep(bytes, { planes, mode: 'trim' })` crops a completed STEP
export at one or more IFC-world half-spaces (`normal · world <= offset`, Z-up,
metres). It preserves product type, GlobalId and semantic associations, replaces
crossing representations, and omits outside elements. `mode: 'whole'` retains
crossing elements in full. The operation requires the WASM runtime and leaves its
input bytes untouched. See the [export guide](../../docs/guide/exporting.md).

## License

[MPL-2.0](../../LICENSE)
