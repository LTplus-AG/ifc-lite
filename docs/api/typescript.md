# TypeScript API Reference

API documentation for the published TypeScript packages.

ifc-lite ships 36 public npm packages: 35 scoped `@ifc-lite/*` packages plus the `create-ifc-lite` scaffolder. This page lists all of them, with API detail for the core packages. Exact type signatures live in each package's `src/index.ts` and shipped `.d.ts` files.

## Package Index

<!-- BEGIN GENERATED: package-index -->
| Package | Description |
|---------|-------------|
| [`@ifc-lite/parser`](#ifc-liteparser) | IFC/STEP parser for IFC-Lite |
| [`@ifc-lite/geometry`](#ifc-litegeometry) | Geometry processing bridge for IFC-Lite - 1.9x faster than web-ifc |
| [`@ifc-lite/data`](#ifc-litedata) | Columnar data structures for IFC-Lite |
| [`@ifc-lite/query`](#ifc-litequery) | Query system for IFC-Lite |
| [`@ifc-lite/spatial`](#ifc-litespatial) | Spatial indexing for IFC-Lite |
| [`@ifc-lite/renderer`](#ifc-literenderer) | WebGPU renderer for IFC-Lite |
| [`@ifc-lite/export`](#ifc-liteexport) | Export formats for IFC-Lite |
| [`@ifc-lite/mutations`](#ifc-litemutations) | Mutation tracking and property editing for IFC-Lite |
| [`@ifc-lite/create`](#ifc-litecreate) | IFC creation from scratch — walls, slabs, beams, columns, stairs, roofs with geometry, properties and quantities |
| [`@ifc-lite/bcf`](#ifc-litebcf) | BIM Collaboration Format (BCF) support for IFC-Lite |
| [`@ifc-lite/ids`](#ifc-liteids) | IDS (Information Delivery Specification) support for IFC-Lite |
| [`@ifc-lite/drawing-2d`](#ifc-litedrawing-2d) | 2D architectural drawing generation from IFC models - section cuts, floor plans, and elevations |
| [`@ifc-lite/clash`](#ifc-liteclash) | Clash detection for IFC-Lite — representation-agnostic core engine + source adapters |
| [`@ifc-lite/diff`](#ifc-litediff) | Headless model-diff engine for IFC-Lite — classifies entities as added/modified/deleted/unchanged across two revisions, with separable data vs geometry scope. |
| [`@ifc-lite/lens`](#ifc-litelens) | Rule-based 3D filtering and colorization for IFC models |
| [`@ifc-lite/lists`](#ifc-litelists) | Configurable property tables and schedules from IFC data for IFC-Lite |
| [`@ifc-lite/ifcx`](#ifc-liteifcx) | IFC5 (IFCX) parser for IFC-Lite |
| [`@ifc-lite/encoding`](#ifc-liteencoding) | IFC string encoding/decoding and property value parsing for IFC-Lite |
| [`@ifc-lite/cache`](#ifc-litecache) | Binary cache format for IFC-Lite - fast model loading |
| [`@ifc-lite/pointcloud`](#ifc-litepointcloud) | Point cloud decoders and types for IFC-Lite |
| [`@ifc-lite/solar`](#ifc-litesolar) | Solar position, sunrise/sunset and 3D sun-path geometry for IFC-Lite |
| [`@ifc-lite/sdk`](#ifc-litesdk) | Scripting SDK for ifc-lite — the bim.* API for BIM automation |
| [`@ifc-lite/sandbox`](#ifc-litesandbox) | QuickJS-in-WASM sandboxed script execution for ifc-lite |
| [`@ifc-lite/extensions`](#ifc-liteextensions) | Extension manifest, capability grammar, and slot registry for ifc-lite user customization |
| [`@ifc-lite/mcp`](#ifc-litemcp) | Model Context Protocol server for ifc-lite — agent-native BIM via MCP (stdio + Streamable HTTP) |
| [`@ifc-lite/cli`](#ifc-litecli) | CLI toolkit for IFC files — query, validate, export, create, and script BIM data |
| [`@ifc-lite/collab`](#ifc-litecollab) | Real-time collaborative BIM via CRDT on IFCX |
| [`@ifc-lite/collab-server`](#ifc-litecollab-server) | Reference websocket sync server for @ifc-lite/collab |
| [`@ifc-lite/embed-sdk`](#ifc-liteembed-sdk) | SDK for embedding the IFC-Lite 3D viewer in any web page via iframe |
| [`@ifc-lite/embed-protocol`](#ifc-liteembed-protocol) | Shared postMessage protocol types for ifc-lite embed viewer and SDK |
| [`@ifc-lite/viewer-core`](#ifc-liteviewer-core) | Interactive 3D viewer for IFC models — WebGL 2 browser viewer with REST API |
| [`@ifc-lite/server-client`](#ifc-liteserver-client) | TypeScript client SDK for IFC-Lite Server |
| [`@ifc-lite/server-bin`](#ifc-liteserver-bin) | Pre-built IFC-Lite server binary - run without Docker or Rust |
| [`@ifc-lite/wasm`](#ifc-litewasm) | WebAssembly bindings for IFC-Lite |
| [`@ifc-lite/codegen`](#ifc-litecodegen) | TypeScript code generator from IFC EXPRESS schemas |
| [`create-ifc-lite`](#create-ifc-lite) | Create IFC-Lite projects with one command |
<!-- END GENERATED: package-index -->

---

## @ifc-lite/parser

IFC/STEP parser producing a columnar `IfcDataStore`.

### IfcParser

```typescript
class IfcParser {
  // Columnar parse (recommended). Accepts ArrayBuffer or SharedArrayBuffer.
  parseColumnar(buffer: ArrayBuffer | SharedArrayBuffer, options?: ParseOptions): Promise<IfcDataStore>;

  // Legacy eager parse into a ParseResult (deprecated, kept as a compatibility adapter)
  parse(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
}
```

#### ParseOptions

```typescript
interface ParseOptions {
  onProgress?: (progress: { phase: string; percent: number }) => void;
  onDiagnostic?: (message: string) => void;
  // Optional IfcAPI instance for WASM-accelerated entity scanning
  wasmApi?: WasmScanApi;
  // Yield budget for large incremental parses
  yieldIntervalMs?: number;
  // Defer indexing of individual property/quantity atoms
  deferPropertyAtomIndex?: boolean;
  // Skip worker-based entity scanning and stay in-process
  disableWorkerScan?: boolean;
  // Called when the spatial hierarchy is ready, before property parsing completes
  onSpatialReady?: (partialStore: IfcDataStore) => void;
  // Pre-built entity index from another worker (e.g. the geometry pre-pass)
  preScannedEntityIndex?: PreScannedEntityIndex;
}
```

### parseAuto

Auto-detects the file format (IFC/STEP vs IFCX/JSON, with transparent `.ifcZIP` unwrap) and parses accordingly.

```typescript
import { parseAuto } from '@ifc-lite/parser';

const result = await parseAuto(buffer);
if (result.format === 'ifc') {
  const store = result.data;        // IfcDataStore
} else {
  const ifcx = result.data;         // IfcxParseResult
  const meshes = result.meshes;     // pre-extracted meshes
}
```

### IfcDataStore

Result of `parseColumnar()`. Key fields (see `src/columnar-parser.ts` for the full interface):

```typescript
interface IfcDataStore extends IfcStoreBase {
  source: Uint8Array;
  entityIndex: { byId: EntityByIdIndex; byType: Map<string, number[]> };

  strings: StringTable;
  entities: EntityTable;
  properties: PropertyTable;
  quantities: QuantityTable;
  relationships: RelationshipGraph;

  parseTime: number;
  // Length unit scale to metres (e.g. 0.001 for mm files)
  lengthUnitScale?: number;

  // On-demand lookup maps: entityId -> related expressIds
  onDemandPropertyMap?: Map<number, number[]>;
  onDemandQuantityMap?: Map<number, number[]>;
  onDemandClassificationMap?: Map<number, number[]>;
  onDemandMaterialMap?: Map<number, number>;
  onDemandDocumentMap?: Map<number, number[]>;
}
```

### On-Demand Extraction

Properties, quantities, and attributes are extracted lazily for memory efficiency.

```typescript
import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractEntityAttributesOnDemand,
} from '@ifc-lite/parser';

// Property sets for one entity
const psets = extractPropertiesOnDemand(store, expressId);

// Quantity sets for one entity
const qsets = extractQuantitiesOnDemand(store, expressId);

// Root attributes for one entity
const attrs = extractEntityAttributesOnDemand(store, expressId);
// { globalId, name, description, objectType, tag }
```

Many more on-demand extractors are exported (classifications, materials, documents, relationships, group members, georeferencing, type properties, schedules); see `packages/parser/src/index.ts`.

Other exports include the STEP scanning/tokenizing building blocks (`StepTokenizer`, `EntityExtractor`, `scanIfcEntities`, `CompactEntityIndex`), unit extraction (`extractProjectUnits`, `ProjectUnits`), the STEP serializer helpers (`generateStepFile`, `toStepLine`, `serializeValue`), the generated IFC schema registry (`SCHEMA_REGISTRY`, `getAttributeNames`), and re-exported IFCX parsing from `@ifc-lite/ifcx`.

---

## @ifc-lite/geometry

Bridge from IFC bytes to per-element triangle meshes, running the Rust kernel via WASM (or a native backend when available).

### GeometryProcessor

```typescript
class GeometryProcessor {
  constructor(options?: GeometryProcessorOptions);

  // Initialize WASM (required before processing)
  init(): Promise<void>;

  // Process IFC buffer and extract geometry (whole-file)
  process(buffer: Uint8Array, entityIndex?: Map<number, any>): Promise<GeometryResult>;

  // Stream geometry for large files (async generator of streaming events)
  processStreaming(/* buffer + streaming options; see the .d.ts */): AsyncGenerator<StreamingGeometryEvent>;

  // Rust-side exporters surfaced on the processor
  exportGlb(buffer, includeMetadata?, hidden?, isolated?, hiddenTypesCsv?, lit?): Uint8Array | null;
  exportGlbFromMeshes(meshes: MeshData[], includeMetadata?, lit?): Uint8Array | null;
  exportObj(/* ... */): Uint8Array | null;
  exportCsv(/* buffer, mode: 'entities'|'properties'|'quantities'|'spatial', ... */): Uint8Array | null;
  exportJson(/* ... */): Uint8Array | null;
  exportJsonld(/* ... */): Uint8Array | null;
  exportStep(/* ... */): Uint8Array | null;
  exportIfcx(buffer, onlyKnownProperties?, pretty?): Uint8Array | null;
  exportMerged(buffers: Uint8Array[], schema?): Uint8Array | null;
  exportKmz(/* ... */): Uint8Array | null;
  exportHbjson(buffer, name): Uint8Array | null;
}
```

### GeometryResult and MeshData

```typescript
interface GeometryResult {
  meshes: MeshData[];
  pointClouds?: PointCloudAsset[];
  totalTriangles: number;
  totalVertices: number;
  coordinateInfo: CoordinateInfo;
}

interface MeshData {
  expressId: number;
  ifcType?: string;
  modelIndex?: number;
  positions: Float32Array;  // [x,y,z, ...]
  normals: Float32Array;    // [nx,ny,nz, ...]
  indices: Uint32Array;     // triangle indices (winding is unreliable; meshes are double-sided)
  color: [number, number, number, number];
  // ... local-frame origin, geometry class, texture fields; see src/types.ts
}
```

`CoordinateInfo` carries the RTC/origin-shift information (`originShift`, `wasmRtcOffset`, `hasLargeCoordinates`, `buildingRotation`, unit scale) needed to place meshes in world space.

---

## @ifc-lite/data

Columnar data structures shared by the parser and downstream packages.

Key exports:

```typescript
// Deduplicated string storage
class StringTable { get(index: number): string; intern(value: string): number; /* ... */ }

// Columnar tables: built once, read everywhere
class EntityTableBuilder { /* build(): EntityTable */ }
class PropertyTableBuilder { /* build(): PropertyTable */ }
class QuantityTableBuilder { /* build(): QuantityTable */ }

// CSR-format relationship graph
class RelationshipGraphBuilder { /* build(): RelationshipGraph */ }
```

Each table type also has `fromColumns` / `toColumns` helpers for structured-clone transfer across workers (`entityTableFromColumns`, `propertyTableToColumns`, ...). Shared enums and types live here too: `IfcTypeEnum`, `PropertyValueType`, `QuantityType`, `RelationshipType`, `SpatialHierarchy`, `IfcStoreBase`, the generated entity-name lists (`ENTITIES_IFC2X3` / `IFC4` / `IFC4X3`), plus utilities like `safeUtf8Decode` and `createLogger`.

---

## @ifc-lite/query

### IfcQuery

Fluent query builder over an `IfcDataStore`.

```typescript
class IfcQuery {
  constructor(store: IfcDataStore);

  // Type shortcuts -> EntityQuery
  walls(): EntityQuery;      // IfcWall + IfcWallStandardCase
  doors(): EntityQuery;
  windows(): EntityQuery;
  slabs(): EntityQuery;
  columns(): EntityQuery;
  beams(): EntityQuery;
  spaces(): EntityQuery;

  // Type filter (variadic), everything, and by id
  ofType(...types: string[]): EntityQuery;
  all(): EntityQuery;
  byId(expressId: number): EntityQuery;

  // Spatial
  onStorey(storeyId: number): EntityQuery;
  inBounds(aabb: AABB): EntityQuery;
  raycast(origin: [number, number, number], direction: [number, number, number]): number[];

  // Graph navigation
  entity(expressId: number): EntityNode;
  get storeys(): EntityNode[];
  get project(): EntityNode | null;

  // SQL (DuckDB-WASM, lazily initialized on first call)
  sql(query: string): Promise<SQLResult>;
}
```

### EntityQuery

```typescript
class EntityQuery {
  whereProperty(psetName: string, propName: string, operator: ComparisonOperator, value: unknown): this;

  limit(count: number): this;
  offset(count: number): this;
  includeGeometry(): this;
  includeProperties(): this;
  includeQuantities(): this;
  includeAll(): this;

  // Terminals
  execute(): QueryResultEntity[];
  ids(): Promise<number[]>;
  count(): Promise<number>;
  first(): Promise<QueryResultEntity | null>;
}
```

### EntityNode

Single-entity graph navigation, from `IfcQuery.entity(id)` or `IfcQuery.storeys`.

```typescript
class EntityNode {
  // Spatial containment
  contains(): EntityNode[];
  containedIn(): EntityNode | null;
  storey(): EntityNode | null;
  building(): EntityNode | null;

  // Aggregation and typing
  decomposes(): EntityNode[];
  decomposedBy(): EntityNode | null;
  definingType(): EntityNode | null;
  instances(): EntityNode[];

  // Voids and fills
  voids(): EntityNode[];
  filledBy(): EntityNode[];

  // Data
  properties(): PropertySet[];
  quantities(): QuantitySet[];
  allAttributes(): Array<{ name: string; value: string | number | boolean }>;

  // Generic traversal
  traverse(relType: RelationshipType, depth: number, direction?: 'forward' | 'inverse'): EntityNode[];
}
```

---

## @ifc-lite/spatial

Spatial indexing utilities for geometry queries and frustum culling.

### buildSpatialIndex

```typescript
import { buildSpatialIndex, buildSpatialIndexAsync } from '@ifc-lite/spatial';
import type { MeshData } from '@ifc-lite/geometry';

function buildSpatialIndex(meshes: MeshData[]): SpatialIndex;
```

**Example:**

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';
import { buildSpatialIndex } from '@ifc-lite/spatial';
import { Renderer } from '@ifc-lite/renderer';

const geometry = new GeometryProcessor();
await geometry.init();
const result = await geometry.process(new Uint8Array(buffer));

// Build spatial index for frustum culling
const spatialIndex = buildSpatialIndex(result.meshes);

const renderer = new Renderer(canvas);
await renderer.init();
renderer.loadGeometry(result);

// Render with frustum culling
renderer.render({
  enableFrustumCulling: true,
  spatialIndex
});
```

### SpatialIndex

```typescript
interface SpatialIndex {
  // Query AABB: expressIds of meshes intersecting bounds
  queryAABB(bounds: AABB): number[];

  // Raycast: expressIds of meshes hit by ray
  raycast(origin: [number, number, number], direction: [number, number, number]): number[];

  // Query frustum: expressIds of meshes visible in frustum
  queryFrustum(frustum: Frustum): number[];
}
```

The underlying `BVH` class, `AABBUtils`, and `FrustumUtils` are also exported.

---

## @ifc-lite/renderer

### Renderer

WebGPU-based 3D renderer.

```typescript
class Renderer {
  constructor(canvas: HTMLCanvasElement);

  // Initialize WebGPU
  init(): Promise<void>;

  // Load geometry (main entry point for IFC geometry)
  loadGeometry(geometry: GeometryResult | MeshData[]): void;

  // Add meshes incrementally (for streaming)
  addMeshes(meshes: MeshData[], isStreaming?: boolean): void;

  // Rendering
  render(options?: RenderOptions): void;

  // Camera controls
  fitToView(): void;
  getCamera(): Camera;

  // Selection (GPU picking)
  pick(x: number, y: number, options?: PickOptions): Promise<PickResult | null>;

  // Scene access
  getScene(): Scene;
  getPipeline(): RenderPipeline | null;
  getGPUDevice(): GPUDevice | null;
  isReady(): boolean;

  // Resize handling
  resize(width: number, height: number): void;
}
```

Visibility is passed via `render()` options (`hiddenIds`, `isolatedIds`); frustum culling via `enableFrustumCulling` plus a `spatialIndex` from `@ifc-lite/spatial`.

Other exports: `Camera`, `Scene`, `Picker`, `PickingManager`, `Raycaster`, `SnapDetector`, `BVH`, `SectionPlaneRenderer`, `Section2DOverlayRenderer`, `PointCloudRenderer`, `FederationRegistry` (multi-model id ranges), and the section-cap / plane-basis helpers.

---

## @ifc-lite/export

Client-side exporters that operate on a parsed `IfcDataStore`.

### StepExporter

Export IFC models back to STEP, with optional visible-only filtering and mutation baking.

```typescript
class StepExporter {
  constructor(dataStore: IfcDataStore, mutationView?: MutablePropertyView);

  export(options: StepExportOptions): StepExportResult;
}

interface StepExportOptions {
  // Output schema; converts entity types when needed
  schema: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
  description?: string;
  author?: string;
  organization?: string;
  application?: string;
  filename?: string;

  includeGeometry?: boolean;       // default true
  includeProperties?: boolean;     // default true
  includeQuantities?: boolean;     // default true
  includeRelationships?: boolean;  // default true

  applyMutations?: boolean;        // bake MutablePropertyView edits
  deltaOnly?: boolean;             // only entities with mutations
  visibleOnly?: boolean;           // filter to viewer-visible entities
  hiddenEntityIds?: Set<number>;   // required when visibleOnly is true
  // ... isolation, progress; see src/step-exporter.ts
}
```

### MergedExporter

Merge multiple IFC models into a single STEP file with a unified ID space, spatial-hierarchy unification, and unit-aware reconciliation.

```typescript
class MergedExporter {
  constructor(models: MergeModelInput[]);
  export(options: MergeExportOptions): MergeExportResult;               // synchronous
  exportAsync(options: MergeExportOptions): Promise<MergeExportResult>; // progress + mutations
}
```

`MergeExportOptions.unitReconciliation` controls mixed length units:

- `'auto'` (default): a model with a different length unit is federated as its own `IfcProject`
- `'normalize'`: rescale it into the first model's unit (one single-unit project)
- `'assume-shared'`: force one project without rescaling

Spatial matching is tunable per container type via `mergeSites` / `mergeBuildings` (`'single' | 'by-name'`) and `mergeStoreys` (`'by-name' | 'by-elevation' | 'by-name-then-elevation'`).

### ParquetExporter

Creates a `.bos` archive (ZIP of Parquet files) from a parsed store, optionally with geometry buffers.

```typescript
class ParquetExporter {
  constructor(store: IfcDataStore, geometryResult?: GeometryResult);

  exportBOS(options?: ParquetExportOptions): Promise<Uint8Array>;
  exportTable(tableName: string): Promise<Uint8Array>;
}
```

### Reference Collection

Low-level closure walking for valid STEP export:

```typescript
// Forward closure walk from root entities
function collectReferencedEntityIds(
  rootIds: Set<number>,
  source: Uint8Array,
  entityIndex: { get(id: number): { byteOffset: number; byteLength: number } | undefined; has(id: number): boolean },
  excludeIds?: Set<number>,
): Set<number>;

// Resolve viewer visibility into export roots
function getVisibleEntityIds(dataStore, hiddenIds, isolatedIds): { roots: Set<number>; hiddenProductIds: Set<number> };

// Reverse pass adding IfcStyledItem entities into the closure (mutates `closure`)
function collectStyleEntities(closure: Set<number>, source: Uint8Array, entityIndex): void;
```

### Other exports

- `Ifc5Exporter`: IFC5/IFCX JSON export
- Schema conversion helpers: `convertEntityType`, `convertStepLine`, `needsConversion`
- GLB helpers: `parseGLB`, `parseGLBToMeshData`, `extractGlbMapping`, `countGlbMeshes`
- LOD generators: `generateLod0`, `generateLod1`

### glTF / GLB and CSV export

The standalone `GltfExporter` and `CsvExporter` classes were removed. glTF/GLB and CSV are produced in Rust and exposed on `GeometryProcessor` (from `@ifc-lite/geometry`): `exportGlb(buffer, ...)`, `exportGlbFromMeshes(meshes, ...)`, and `exportCsv(buffer, mode, ...)` where `mode` is one of `entities`, `properties`, `quantities`, or `spatial`.

---

## @ifc-lite/mutations

Property editing with bidirectional change tracking. Nothing mutates the parsed buffer; edits accumulate in an overlay and materialise during `StepExporter.export({ applyMutations: true })`.

### MutablePropertyView

Wraps a `PropertyTable` with a mutation overlay for non-destructive property editing.

```typescript
class MutablePropertyView {
  constructor(baseTable: PropertyTable | null, modelId: string);

  // Reads (with mutations applied)
  getForEntity(entityId: number): PropertySet[];
  getPropertyValue(entityId: number, psetName: string, propName: string): PropertyValue | null;

  // Property edits (each returns/records a Mutation)
  setProperty(entityId, psetName, propName, value, valueType?, unit?): Mutation;
  deleteProperty(entityId, psetName, propName): Mutation | null;
  createPropertySet(entityId, psetName, properties): Mutation;
  deletePropertySet(entityId, psetName): Mutation;

  // Positional STEP-argument overrides (profiles, points, ...)
  setPositionalAttribute(entityId, index, value, skipHistory?): Mutation;
  getPositionalMutationsForEntity(entityId): Map<number, IfcAttributeValue> | null;
  removePositionalMutation(entityId, index): void;

  // Entity churn in the overlay
  createEntity(type: string, attributes: IfcAttributeValue[]): NewEntity;
  deleteEntity(expressId: number): boolean;
  getNewEntities(): NewEntity[];
  isDeleted(expressId: number): boolean;
  getTombstones(): Set<number>;
  restoreFromTombstone(expressId: number): boolean;

  // Bookkeeping
  getMutations(): Mutation[];
  hasChanges(entityId?: number): boolean;
  applyMutations(mutations: Mutation[]): void;
  exportMutations(): string;
  importMutations(json: string): void;
  clear(): void;
}
```

### StoreEditor

High-level facade for editing a parsed `IfcDataStore` via the `MutablePropertyView` overlay.

```typescript
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

const view = new MutablePropertyView(propertyTable, modelId);
const editor = new StoreEditor(dataStore, view);

const profile = editor.addEntity('IFCRECTANGLEPROFILEDEF', [
  '.AREA.', null, '#34', 0.6, 0.4,
]);
editor.setPositionalAttribute(profile.expressId, 3, 0.7);
editor.removeEntity(unwantedExpressId);
```

```typescript
class StoreEditor {
  constructor(store: IfcDataStore, view: MutablePropertyView);

  // Add a new entity to the overlay (returns a synthetic EntityRef with a fresh expressId)
  addEntity(type: string, attributes: IfcAttributeValue[]): EntityRef;

  // Tombstone an existing entity or forget an overlay-only one
  removeEntity(expressId: number): boolean;

  // Override a single positional STEP arg by zero-based index
  setPositionalAttribute(expressId: number, index: number, value: IfcAttributeValue): void;

  // Edit a named root attribute (Name, Description, ObjectType, ...)
  setAttribute(expressId: number, attrName: string, value: string): void;

  getNewEntity(expressId: number): NewEntity | null;
  getNewEntities(): NewEntity[];
}
```

#### Value conventions

`addEntity` and `setPositionalAttribute` accept the same shape that `EntityExtractor.extractEntity().attributes` produces:

| JS value | STEP literal |
|---|---|
| `null` / `undefined` | `$` |
| `42` / `0.6` | integer / REAL |
| `true` / `false` | `.T.` / `.F.` |
| `"#42"` (string) | entity reference |
| `".AREA."` (string) | enum |
| `"My Column"` (string) | quoted STEP string |
| `[1, 2, 3]` | STEP list `(1,2,3)`, recursive |

### ChangeSetManager

Manage named groups of mutations: `createChangeSet`, `setActiveChangeSet`, `addMutation`, `mergeChangeSets`, `exportChangeSet` / `importChangeSet`, and friends.

### BulkQueryEngine

Query and update entities in bulk.

```typescript
class BulkQueryEngine {
  select(criteria: SelectionCriteria): number[];
  preview(query: BulkQuery): BulkQueryPreview;
  execute(query: BulkQuery): BulkQueryResult;
}
```

### CsvConnector

Import property updates from CSV files: `parse`, `match`, `generateMutations`, `import`, `preview`, `autoDetectMappings`.

Mutation types cover properties (`CREATE/UPDATE/DELETE_PROPERTY`, `CREATE/DELETE_PROPERTY_SET`), quantities, named attributes (`UPDATE_ATTRIBUTE`), positional STEP args (`UPDATE_POSITIONAL_ATTRIBUTE`), and entity churn (`CREATE_ENTITY`, `DELETE_ENTITY`).

---

## @ifc-lite/create

Build valid IFC4 STEP files programmatically, or add elements into an already-parsed model.

### IfcCreator

```typescript
import { IfcCreator } from '@ifc-lite/create';

const creator = new IfcCreator({ Name: 'My Project' });
const storey = creator.addIfcBuildingStorey({ Name: 'Ground Floor', Elevation: 0 });
creator.addIfcWall(storey, {
  Start: [0, 0, 0], End: [5, 0, 0],
  Thickness: 0.2, Height: 3,
});
const { content } = creator.toIfc();
```

```typescript
class IfcCreator {
  constructor(params?: ProjectParams);

  // Spatial structure
  addIfcBuildingStorey(params: StoreyParams): number;

  // Building elements (each returns the new expressId)
  addIfcWall(storeyId, params: WallParams): number;
  addIfcSlab(storeyId, params: SlabParams): number;
  addIfcColumn(storeyId, params: ColumnParams): number;
  addIfcBeam(storeyId, params: BeamParams): number;
  addIfcStair(storeyId, params: StairParams): number;
  addIfcRoof(storeyId, params: RoofParams): number;
  addIfcGableRoof(storeyId, params: GableRoofParams): number;
  addIfcDoor(storeyId, params: DoorParams): number;
  addIfcWindow(storeyId, params: WindowParams): number;
  addIfcWallDoor(wallId, params: WallDoorParams): number;    // door + opening in a wall
  addIfcWallWindow(wallId, params: WallWindowParams): number;
  addIfcRamp(storeyId, params: RampParams): number;
  addIfcRailing(storeyId, params: RailingParams): number;
  addIfcPlate(storeyId, params: PlateParams): number;
  addIfcMember(storeyId, params: MemberParams): number;
  addIfcFooting(storeyId, params: FootingParams): number;
  addIfcPile(storeyId, params: PileParams): number;
  addIfcSpace(storeyId, params: SpaceParams): number;

  // Properties, quantities, materials, colour
  addIfcPropertySet(elementId, pset: PropertySetDef): number;
  addIfcElementQuantity(elementId, qset: QuantitySetDef): number;
  addIfcMaterial(elementId, material: MaterialDef): void;
  setColor(elementId, name: string, rgb: [number, number, number]): void;

  // Generate STEP file
  toIfc(): CreateResult;
}
```

```typescript
interface ProjectParams {
  Name?: string;
  Description?: string;
  Schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  LengthUnit?: string;  // 'METRE' (default), 'MILLIMETRE', 'FOOT'
  Author?: string;
  Organization?: string;
}
```

Parameter interfaces for every element type live in `packages/create/src/types.ts` (e.g. `WallParams` with `Start`, `End`, `Thickness`, `Height`, optional `Openings`).

### In-Store Builders

For editing an **already-parsed** `IfcDataStore`, the package exposes anchored builders that emit a complete sub-graph (placement, profile, solid, representation, containment) into a `StoreEditor` overlay:

`addColumnToStore`, `addWallToStore`, `addSlabToStore`, `addBeamToStore`, `addDoorToStore`, `addWindowToStore`, `addSpaceToStore`, `addRoofToStore`, `addPlateToStore`, `addMemberToStore`.

```typescript
import { StoreEditor } from '@ifc-lite/mutations';
import { addColumnToStore, resolveSpatialAnchor } from '@ifc-lite/create';

const editor = new StoreEditor(dataStore, mutationView);
const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);

const result = addColumnToStore(editor, anchor, {
  Position: [1, 1, 0],
  Width: 0.3, Depth: 0.4, Height: 3,
  Name: 'Column 1',
});
```

#### resolveSpatialAnchor

Walks a parsed `IfcDataStore` for the references every in-store builder needs. Throws if `IfcOwnerHistory`, the 'Body' representation context, or the storey's `IfcLocalPlacement` cannot be resolved.

```typescript
function resolveSpatialAnchor(store: IfcDataStore, storeyExpressId: number): SpatialAnchor;

interface SpatialAnchor {
  ownerHistoryId: number;    // referenced by every IfcRoot
  bodyContextId: number;     // 'Body' subcontext (or parent context fallback)
  storeyId: number;
  storeyPlacementId: number; // the storey's own IfcLocalPlacement
}
```

---

## @ifc-lite/bcf

BCF (BIM Collaboration Format) support for issue tracking. Implements BCF 2.1 and 3.0.

### readBCF / writeBCF

```typescript
// Read a BCF/BCFzip file (accepts File, Blob, or ArrayBuffer)
function readBCF(file: File | Blob | ArrayBuffer): Promise<BCFProject>;

// Write a BCF file (returns a Blob)
function writeBCF(project: BCFProject): Promise<Blob>;
```

### Creation and mutation helpers

```typescript
function createBCFProject(options?: { name?: string; version?: '2.1' | '3.0' }): BCFProject;
function createBCFTopic(options: { title: string; author: string; /* ... */ }): BCFTopic;
function createBCFComment(options: { author: string; comment: string }): BCFComment;

function addTopicToProject(project: BCFProject, topic: BCFTopic): void;
function addCommentToTopic(topic: BCFTopic, comment: BCFComment): void;
function addViewpointToTopic(topic: BCFTopic, viewpoint: BCFViewpoint): void;
function updateTopicStatus(/* topic, status, ... */): void;
```

### Viewpoints

```typescript
// Create a viewpoint from viewer state (camera, section plane, selection, visibility, snapshot)
function createViewpoint(options): BCFViewpoint;

// Extract viewer state from a BCF viewpoint
function extractViewpointState(viewpoint: BCFViewpoint): {
  camera?: ViewerCameraState;
  sectionPlane?: ViewerSectionPlane;
  selectedGuids: string[];
  hiddenGuids: string[];
  visibleGuids: string[];
  coloredGuids: { color: string; guids: string[] }[];
};
```

### Utilities

GUID conversion (`uuidToIfcGuid`, `ifcGuidToUuid`, `generateIfcGuid`, `isValidIfcGuid`), ARGB colour helpers (`parseARGBColor`, `toARGBColor`), 3D marker overlay (`computeMarkerPositions`, `BCFOverlayRenderer`), and `createBCFFromIDSReport` to turn an IDS validation report into BCF topics.

---

## @ifc-lite/ids

IDS (Information Delivery Specification) validation. Implements IDS 1.0 with all facet and constraint types.

### parseIDS / validateIDS

```typescript
// Parse an IDS XML file (accepts string or ArrayBuffer)
function parseIDS(xmlContent: string | ArrayBuffer): IDSDocument;

// Run validation against IFC data
function validateIDS(
  document: IDSDocument,
  accessor: IFCDataAccessor,
  modelInfo: IDSModelInfo,
  options?: ValidatorOptions
): Promise<IDSValidationReport>;
```

### Facet checking

```typescript
function checkFacet(facet, entity, accessor): boolean;
function filterByFacet(facet, entities, accessor): EntityRef[];
function checkEntityFacet(facet, entity): boolean;
function checkAttributeFacet(facet, entity, accessor): boolean;
function checkPropertyFacet(facet, entity, accessor): boolean;
function checkClassificationFacet(facet, entity, accessor): boolean;
function checkMaterialFacet(facet, entity, accessor): boolean;
function checkPartOfFacet(facet, entity, accessor): boolean;
```

### Constraints, audit, translation

```typescript
function matchConstraint(constraint: IDSConstraint, value: unknown): boolean;
function formatConstraint(constraint: IDSConstraint): string;
function getConstraintMismatchReason(constraint: IDSConstraint, value: unknown): string;

// IDS document correctness audit
function auditIDSDocument(/* ... */): IDSAuditReport;
function auditIDSStructure(/* ... */): IDSAuditReport;

// Report localisation
function createTranslationService(locale: 'en' | 'de' | 'fr'): TranslationService;
```

---

## @ifc-lite/drawing-2d

2D architectural drawing generation from 3D IFC models: section cuts, floor plans, and elevations.

### High-level generation

```typescript
class Drawing2DGenerator {
  initialize(): Promise<void>;
  generate(meshes: MeshData[], config: SectionConfig, options?: Partial<GeneratorOptions>): Promise<Drawing2D>;
  dispose(): void;
}

function generateFloorPlan(meshes: MeshData[], elevation: number, options?: Partial<GeneratorOptions>): Promise<Drawing2D>;
function generateSection(meshes: MeshData[], axis: 'x' | 'z', position: number, options?: Partial<GeneratorOptions>): Promise<Drawing2D>;
function createSectionConfig(axis: 'x' | 'y' | 'z', position: number, options?: Partial<Omit<SectionConfig, 'plane'>>): SectionConfig;
```

### Pipeline pieces

- Section cutting: `SectionCutter`, `cutMeshesStreaming`, GPU-accelerated `GPUSectionCutter` + `isGPUComputeAvailable`
- Polygons: `PolygonBuilder`, `simplifyPolygon`, `polygonBounds`
- Edges and visibility: `EdgeExtractor`, `HiddenLineClassifier`, `projectProfiles`
- Hatching: `HatchGenerator`, `HATCH_PATTERNS`, `getHatchPattern`
- Openings and symbols: `buildOpeningRelationships`, `generateDoorSymbol`, `generateWindowSymbol`, `generateStairArrow`
- Graphic overrides: `GraphicOverrideEngine`, `createOverrideEngine`, presets `ARCHITECTURAL_PRESET` and `FIRE_SAFETY_PRESET`
- SVG output: `SVGExporter`, `exportToSVG`
- Sheets: `createFrame`, `createTitleBlock`, `renderFrame`, `renderTitleBlock`, `renderScaleBar`, `PAPER_SIZE_REGISTRY`
- Constants: `LINE_STYLES`, `COMMON_SCALES`, `PAPER_SIZES`

---

## @ifc-lite/clash

Clash detection with a representation-agnostic core engine plus source adapters. Key exports: `createClashEngine` (pluggable `ClashBackend`, including the WASM-native one), `groupClashes`, `matchesSelector`, exclusion helpers (`makeExclusionSet`, `isExcluded`, `pairKey`), and the shared clash types.

## @ifc-lite/diff

Headless model-diff engine: classifies entities as added / modified / deleted / unchanged across two revisions, with separable data vs geometry scope. Main entry point: `diffModels`.

## @ifc-lite/lens

Rule-based 3D filtering and colorization for IFC models: `evaluateLens`, `evaluateAutoColorLens`, `matchesCriteria`, class/data-source discovery (`discoverClasses`, `discoverDataSources`), and `BUILTIN_LENSES` presets.

## @ifc-lite/lists

Configurable property tables and schedules from IFC data: `executeList`, `listResultToCSV`, `summariseListRows`, column discovery (`discoverColumns`), name patterns (`compileNameMatcher`), and `LIST_PRESETS`.

## @ifc-lite/ifcx

IFC5 (IFCX) parser: `parseIfcx`, `parseFederatedIfcx`, `composeIfcx`, `detectFormat`, layer stacking (`createLayerStack`, `addIfcxOverlay`), entity/property/geometry extractors, and hierarchy building. Re-exported through `@ifc-lite/parser` for `parseAuto`.

## @ifc-lite/encoding

IFC string encoding/decoding and property value parsing: `decodeIfcString`, `encodeIfcString`, `parsePropertyValue`.

## @ifc-lite/cache

Binary cache format for fast model loading: `BinaryCacheWriter`, `BinaryCacheReader`, plus hashing (`xxhash64`) and buffer utilities. Used by the viewer to skip re-parsing unchanged files.

## @ifc-lite/pointcloud

Point cloud decoders and types: `decodePcd`, LAS/LAZ support including `LasStreamingSource` for chunked streaming, and `decompressLZF`.

## @ifc-lite/solar

Solar position, sunrise/sunset, and 3D sun-path geometry: `sunPosition`, `sunTimes`, and the sun-path dome builders (day paths, hourly analemmas). Renderer-agnostic.

## @ifc-lite/sdk

Scripting SDK: the `bim.*` API for BIM automation. `createBimContext` builds a `BimContext` whose namespaces (`QueryNamespace`, `ModelNamespace`, `ViewerNamespace`, `MutateNamespace`, `StoreNamespace`, ...) run against either the browser viewer or a headless backend.

## @ifc-lite/sandbox

QuickJS-in-WASM sandboxed script execution: `createSandbox` / `Sandbox`, `buildBridge` (marshals the `bim.*` API across the sandbox boundary), and `transpileTypeScript`.

## @ifc-lite/extensions

Extension manifest, capability grammar, and slot registry for user customization: `validateManifest`, `migrateManifest`, `SlotRegistry`, capability and `when`-clause evaluation, bundle and storage helpers.

## @ifc-lite/mcp

Model Context Protocol server for ifc-lite: agent-native BIM via MCP over stdio or Streamable HTTP. Exports `MCPServer` plus the model-registry and tool-context types; also ships the `ifc-lite-mcp` CLI entry point.

## @ifc-lite/cli

CLI toolkit for IFC files (binary name `ifc-lite`): query, validate (IDS), export (CSV/JSON/IFC/glTF/Parquet), create, merge, convert, diff, clash-check, and script the SDK.

## @ifc-lite/collab

Real-time collaborative BIM via CRDT on IFCX: document schema, entity/relationship/geometry operations, and snapshot support.

## @ifc-lite/collab-server

Reference websocket sync server for `@ifc-lite/collab`.

## @ifc-lite/embed-sdk

SDK for embedding the IFC-Lite 3D viewer in any web page via iframe. Main export: the `IFCLiteEmbed` class with typed commands and an `EventMap` for viewer events.

## @ifc-lite/embed-protocol

Shared postMessage protocol types for the embed viewer and SDK: message envelope, inbound command and outbound event types, and `PROTOCOL_VERSION`.

## @ifc-lite/viewer-core

Interactive 3D viewer for IFC models: a WebGL 2 browser viewer with a REST API. Published from `packages/viewer`; main export is `getViewerHtml` plus the server/embedding helpers.

## @ifc-lite/server-client

TypeScript client SDK for IFC-Lite Server: typed REST client plus Parquet geometry decoding (`decodeParquetGeometry`, `decodeOptimizedParquetGeometry`).

## @ifc-lite/server-bin

Pre-built `ifc-lite-server` binaries for deployment without a Rust toolchain or Docker. Installs a launcher (`ifc-lite-server`) that downloads and verifies the platform binary.

**Supported platforms:**

| Platform | Architecture |
|------------------|-------------|
| `linux-x64` | x86_64 |
| `linux-arm64` | aarch64 |
| `linux-x64-musl` | x86_64 (musl libc) |
| `darwin-x64` | x86_64 (macOS) |
| `darwin-arm64` | aarch64 (macOS Apple Silicon) |
| `win32-x64` | x86_64 (Windows) |

## @ifc-lite/wasm

WebAssembly bindings (the `IfcAPI` class and mesh/profile/clash types). See the [WASM API reference](wasm.md).

## @ifc-lite/codegen

TypeScript code generator from IFC EXPRESS schemas. Produces the 876-entity type definitions, CRC32 type ids, serializers, and the parser's generated Rust tables (`generateTypeIds`, `generateSerializers`, `generateRust`). Primarily a build-time tool, not used at runtime.

## create-ifc-lite

Project scaffolder: `npm create ifc-lite` (binary `create-ifc-lite`) sets up a new IFC-Lite project with one command.
