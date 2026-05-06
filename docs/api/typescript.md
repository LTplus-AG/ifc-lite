# TypeScript API Reference

Complete API documentation for the TypeScript packages.

## @ifc-lite/parser

### IfcParser

Main class for parsing IFC files.

```typescript
class IfcParser {
  constructor(options?: ParserOptions);

  // Parse from ArrayBuffer (returns entities as objects)
  parse(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;

  // Columnar parse (returns IfcDataStore - recommended)
  parseColumnar(buffer: ArrayBuffer, options?: ParseOptions): Promise<IfcDataStore>;
}
```

#### ParserOptions

```typescript
interface ParserOptions {
  // Use WASM parser (default: true if available)
  useWasm?: boolean;

  // Worker configuration
  useWorker?: boolean;
  workerUrl?: string;
}
```

#### ParseOptions

```typescript
interface ParseOptions {
  // Progress callback
  onProgress?: (progress: Progress) => void;

  // Geometry quality: 'FAST' | 'BALANCED' | 'HIGH'
  geometryQuality?: GeometryQuality;

  // Skip geometry processing
  skipGeometry?: boolean;

  // Auto-shift large coordinates
  autoOriginShift?: boolean;

  // Custom origin point
  customOrigin?: Vector3;

  // Memory limit in MB
  memoryLimit?: number;

  // Entity type filters
  includeTypes?: string[];
  excludeTypes?: string[];
}
```

### parseAuto

Standalone function that auto-detects parser based on environment.

```typescript
import { parseAuto } from '@ifc-lite/parser';

// Auto-selects best parser for current environment
const store = await parseAuto(buffer);
```

### ParseResult

Result object returned from `parse()` method.

```typescript
interface ParseResult {
  // Entity data as Map
  readonly entities: Map<number, any>;
  readonly entityCount: number;

  // Property sets
  readonly propertySets: Map<number, any>;

  // Relationships
  readonly relationships: any[];

  // Entity index
  readonly entityIndex: EntityIndex;

  // File info
  readonly fileSize: number;
}
```

### IfcDataStore

Result object returned from `parseColumnar()` method (recommended).

```typescript
interface IfcDataStore {
  // Entity index for fast lookups
  readonly entityIndex: EntityIndex;

  // Schema version: 'IFC2X3' | 'IFC4' | 'IFC4X3'
  readonly schemaVersion: string;

  // Statistics
  readonly entityCount: number;
  readonly parseTime: number;

  // Length unit scale (e.g., 0.001 for mm files)
  readonly lengthUnitScale: number;

  // Spatial hierarchy
  readonly spatialHierarchy: SpatialHierarchy;
}

interface EntityIndex {
  // Lookup by expressId
  byId: Map<number, EntityRef>;

  // Lookup by type (e.g., 'IFCWALL' -> [expressId1, expressId2, ...])
  byType: Map<string, number[]>;
}
```

### On-Demand Property Extraction

Properties are extracted lazily for memory efficiency.

```typescript
import { 
  extractPropertiesOnDemand, 
  extractQuantitiesOnDemand,
  extractEntityAttributesOnDemand 
} from '@ifc-lite/parser';

// Extract properties for a single entity
const props = extractPropertiesOnDemand(store, expressId, buffer);
// Returns: { 'Pset_WallCommon': { LoadBearing: true, ... }, ... }

// Extract quantities for a single entity
const quantities = extractQuantitiesOnDemand(store, expressId, buffer);
// Returns: { Volume: { value: 1.5, unit: 'm³' }, ... }

// Extract entity attributes
const attrs = extractEntityAttributesOnDemand(store, expressId, buffer);
// Returns: { Name: 'Wall 1', GlobalId: '...' }
```

### Entity

```typescript
interface Entity {
  readonly expressId: number;
  readonly type: string;
  readonly globalId: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly hasGeometry: boolean;
}
```

---

## @ifc-lite/geometry

### GeometryProcessor

Main class for extracting geometry from IFC files.

```typescript
class GeometryProcessor {
  constructor();

  // Initialize WASM (required before processing)
  init(): Promise<void>;

  // Check if initialized
  isInitialized(): boolean;

  // Process IFC buffer and extract geometry
  process(buffer: Uint8Array): Promise<GeometryResult>;

  // Stream geometry for large files
  processStreaming(
    buffer: Uint8Array,
    entityIndex?: Map<number, any>,
    batchSize?: number
  ): AsyncGenerator<StreamEvent>;

  // Coordinate handling
  getCoordinateInfo(): CoordinateInfo | null;
}
```

#### StreamEvent

```typescript
type StreamEvent =
  | { type: 'start' }
  | { type: 'batch'; meshes: MeshData[]; progress: number }
  | { type: 'complete'; totalMeshes: number; coordinateInfo: CoordinateInfo };
```

### GeometryResult

```typescript
interface GeometryResult {
  readonly meshes: MeshData[];
  readonly coordinateInfo?: CoordinateInfo;
}

interface CoordinateInfo {
  shift?: { x: number; y: number; z: number };
  bounds: BoundingBox;
}
```

### MeshData

Raw geometry data (Float32Arrays, not GPU buffers).

```typescript
interface MeshData {
  readonly expressId: number;
  readonly positions: Float32Array;  // [x, y, z, x, y, z, ...]
  readonly normals: Float32Array;    // [nx, ny, nz, ...]
  readonly indices: Uint32Array;     // Triangle indices
  readonly color: [number, number, number, number];  // RGBA (0-1)
}
```

---

## @ifc-lite/spatial

Spatial indexing utilities for efficient geometry queries and frustum culling.

### buildSpatialIndex

Builds a BVH (Bounding Volume Hierarchy) spatial index from geometry meshes.

```typescript
import { buildSpatialIndex } from '@ifc-lite/spatial';
import type { MeshData } from '@ifc-lite/geometry';

function buildSpatialIndex(meshes: MeshData[]): SpatialIndex;
```

**Parameters:**
- `meshes: MeshData[]` - Array of mesh data objects from `GeometryProcessor.process()`

**Returns:**
- `SpatialIndex` - BVH spatial index implementing the SpatialIndex interface

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

Interface for spatial queries.

```typescript
interface SpatialIndex {
  /**
   * Query AABB - returns expressIds of meshes intersecting bounds
   */
  queryAABB(bounds: AABB): number[];

  /**
   * Raycast - returns expressIds of meshes hit by ray
   */
  raycast(origin: [number, number, number], direction: [number, number, number]): number[];

  /**
   * Query frustum - returns expressIds of meshes visible in frustum
   */
  queryFrustum(frustum: Frustum): number[];
}
```

### Types

```typescript
interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

interface Frustum {
  planes: Plane[];
}

interface Plane {
  normal: [number, number, number];
  distance: number;
}
```

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
  pick(x: number, y: number, options?: PickOptions): Promise<number | null>;

  // Visibility (pass to render() options)
  // hiddenIds?: Set<number>;
  // isolatedIds?: Set<number> | null;

  // Scene access
  getScene(): Scene;
  getPipeline(): RenderPipeline | null;
  getGPUDevice(): GPUDevice | null;
  isReady(): boolean;

  // Resize handling
  resize(width: number, height: number): void;
}
```

#### RendererOptions

```typescript
interface RendererOptions {
  antialias?: boolean;
  sampleCount?: 1 | 4;
  backgroundColor?: Color;
  powerPreference?: 'low-power' | 'high-performance';
  enablePicking?: boolean;
  enableShadows?: boolean;
  enableSectionPlanes?: boolean;
}
```

#### CameraOptions

```typescript
interface CameraOptions {
  position?: Vector3;
  target?: Vector3;
  up?: Vector3;
  fov?: number;
  near?: number;
  far?: number;
  orbitSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
}
```

#### ViewPreset

```typescript
type ViewPreset =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'iso'
  | 'iso-back';
```

---

## @ifc-lite/query

### IfcQuery

Fluent query builder.

```typescript
class IfcQuery {
  constructor(parseResult: ParseResult);

  // Enable SQL queries
  enableSQL(): Promise<void>;

  // Type shortcuts
  walls(): IfcQuery;
  doors(): IfcQuery;
  windows(): IfcQuery;
  slabs(): IfcQuery;
  roofs(): IfcQuery;
  columns(): IfcQuery;
  beams(): IfcQuery;
  spaces(): IfcQuery;
  storeys(): IfcQuery;
  all(): IfcQuery;

  // Type filter
  ofType(type: string): IfcQuery;
  ofTypes(types: string[]): IfcQuery;

  // Property filters
  whereProperty(
    psetName: string,
    propName: string,
    operator: Operator,
    value: any
  ): IfcQuery;

  whereQuantity(
    name: string,
    operator: Operator,
    value: number
  ): IfcQuery;

  // Spatial queries
  storey(name: string): IfcQuery;
  building(name: string): IfcQuery;
  contains(): IfcQuery;
  containedIn(): IfcQuery;
  allContained(): IfcQuery;

  // Entity navigation
  entity(expressId: number): EntityQuery;

  // Selection
  select(fields: string[]): IfcQuery;

  // Output
  toArray(): Entity[];
  first(): Entity | undefined;
  count(): number;

  // SQL
  sql(query: string): Promise<any[]>;
}

type Operator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IN';
```

### EntityQuery

Query operations on a single entity.

```typescript
class EntityQuery {
  // Relationships
  contains(): IfcQuery;
  containedIn(): EntityQuery;
  materials(): IfcQuery;
  propertySets(): PropertySet[];
  related(relType: string): IfcQuery;

  // Navigation
  storey(): EntityQuery;
  building(): EntityQuery;
  site(): EntityQuery;

  // Output
  entity(): Entity;
}
```

---

## @ifc-lite/data

### EntityTable

Columnar entity storage.

```typescript
class EntityTable {
  readonly count: number;
  readonly expressIds: Uint32Array;
  readonly typeEnums: Uint16Array;
  readonly globalIdIndices: Uint32Array;
  readonly nameIndices: Uint32Array;
  readonly flags: Uint8Array;

  get(index: number): EntityRow;
  findByExpressId(id: number): number;
  filter(predicate: (row: EntityRow) => boolean): number[];
}
```

### StringTable

Deduplicated string storage.

```typescript
class StringTable {
  readonly count: number;

  get(index: number): string;
  intern(value: string): number;
  has(value: string): boolean;
}
```

### RelationshipGraph

CSR-format graph for relationships.

```typescript
class RelationshipGraph {
  // Get related entities
  getRelated(expressId: number, relType?: string): number[];

  // Get container
  getContainer(expressId: number): number | null;

  // Get contained elements
  getContained(expressId: number): number[];

  // Get all descendants
  getAllContained(expressId: number): number[];

  // Build spatial hierarchy
  getSpatialHierarchy(): HierarchyNode;
}
```

---

## @ifc-lite/export

### StepExporter

Export IFC models back to STEP format with optional visible-only filtering.

```typescript
class StepExporter {
  constructor(dataStore: IfcDataStore, source: Uint8Array);

  export(options?: StepExportOptions): StepExportResult;
}

interface StepExportOptions {
  visibleOnly?: boolean;
  hiddenEntityIds?: Set<number>;
  isolatedEntityIds?: Set<number> | null;
  applyMutations?: boolean;
  deltaOnly?: boolean;
}

interface StepExportResult {
  content: string;
  stats: { entityCount: number };
}
```

### MergedExporter

Merge multiple IFC models into a single STEP file with unified ID space.

```typescript
class MergedExporter {
  export(
    models: MergeModelInput[],
    options?: MergeExportOptions
  ): MergeExportResult;
}

interface MergeModelInput {
  dataStore: IfcDataStore;
  source: Uint8Array;
  name?: string;
}
```

### collectReferencedEntityIds / collectStyleEntities

Low-level reference collection for building the entity closure needed for valid STEP export.

```typescript
// Forward closure walk from root entities
function collectReferencedEntityIds(
  store: IfcDataStore,
  source: Uint8Array,
  hiddenIds?: Set<number>,
  isolatedIds?: Set<number> | null
): Set<number>;

// Reverse pass to collect IfcStyledItem entities
function collectStyleEntities(
  store: IfcDataStore,
  source: Uint8Array,
  referencedIds: Set<number>
): Set<number>;
```

### GltfExporter

```typescript
class GltfExporter {
  export(
    parseResult: ParseResult,
    options?: GltfExportOptions
  ): Promise<GltfResult>;
}

interface GltfExportOptions {
  format: 'gltf' | 'glb';
  includeProperties?: boolean;
  embedImages?: boolean;
  useDraco?: boolean;
  yUp?: boolean;
  entityFilter?: (entity: Entity) => boolean;
}
```

### ParquetExporter

```typescript
class ParquetExporter {
  exportEntities(parseResult: ParseResult): Promise<Uint8Array>;
  exportProperties(parseResult: ParseResult): Promise<Uint8Array>;
  exportQuantities(parseResult: ParseResult): Promise<Uint8Array>;
  exportAll(parseResult: ParseResult): Promise<ParquetBundle>;
}
```

### CsvExporter

```typescript
class CsvExporter {
  exportEntities(
    parseResult: ParseResult,
    options?: CsvOptions
  ): Promise<string>;

  exportPropertiesPivot(
    parseResult: ParseResult,
    options?: PivotOptions
  ): Promise<string>;
}
```

---

## Common Types

### Vector3

```typescript
interface Vector3 {
  x: number;
  y: number;
  z: number;
}
```

### Color

```typescript
type Color = [number, number, number, number]; // RGBA, 0-1
```

### BoundingBox

```typescript
interface BoundingBox {
  min: Vector3;
  max: Vector3;
  center: Vector3;
  size: Vector3;
}
```

### Matrix4

```typescript
type Matrix4 = Float32Array; // 16 elements, column-major
```

### Progress

```typescript
interface Progress {
  percent: number;
  entitiesProcessed?: number;
  totalEntities?: number;
  stage?: string;
}
```

---

## @ifc-lite/bcf

BCF (BIM Collaboration Format) support for issue tracking in BIM projects. Implements BCF 2.1 and 3.0.

### readBCF / writeBCF

```typescript
// Read a BCF/BCFzip file (accepts File, Blob, or ArrayBuffer)
function readBCF(file: File | Blob | ArrayBuffer): Promise<BCFProject>;

// Write a BCF file (returns a Blob)
function writeBCF(project: BCFProject): Promise<Blob>;
```

### createBCFProject

```typescript
function createBCFProject(options?: {
  name?: string;
  version?: '2.1' | '3.0';
}): BCFProject;
```

### createBCFTopic / createBCFComment

```typescript
function createBCFTopic(options: {
  title: string;
  author: string;
  // ... additional topic fields
}): BCFTopic;

function createBCFComment(options: {
  author: string;
  comment: string;
}): BCFComment;
```

### Project Mutation Helpers

```typescript
// Add topic to project
function addTopicToProject(project: BCFProject, topic: BCFTopic): void;

// Add comment to topic
function addCommentToTopic(topic: BCFTopic, comment: BCFComment): void;

// Add viewpoint to topic
function addViewpointToTopic(topic: BCFTopic, viewpoint: BCFViewpoint): void;
```

### Viewpoints

```typescript
// Create a viewpoint from viewer state
function createViewpoint(options: {
  camera: ViewerCameraState;
  sectionPlane?: ViewerSectionPlane;
  selectedGuids?: string[];
  hiddenGuids?: string[];
  visibleGuids?: string[];
  snapshot?: string;
}): BCFViewpoint;

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

### GUID Utilities

```typescript
function uuidToIfcGuid(uuid: string): string;
function ifcGuidToUuid(guid: string): string;
function generateIfcGuid(): string;
function isValidIfcGuid(guid: string): boolean;
```

### Types

```typescript
interface BCFProject {
  // Project metadata and topics
}

interface BCFTopic {
  // Topic with title, author, status, comments, viewpoints
}

interface BCFComment {
  // Comment with author, text, and timestamp
}

interface BCFViewpoint {
  // Viewpoint with camera position, components, and clipping planes
}

interface BCFComponents {
  // Component visibility and selection state
}

interface BCFClippingPlane {
  // Clipping plane definition
}
```

---

## @ifc-lite/ids

IDS (Information Delivery Specification) validation. Implements IDS 1.0 with all facet and constraint types.

### parseIDS

```typescript
// Parse an IDS XML file (accepts string or ArrayBuffer)
function parseIDS(xmlContent: string | ArrayBuffer): IDSDocument;
```

### validateIDS

```typescript
// Run validation against IFC data
function validateIDS(
  document: IDSDocument,
  accessor: IFCDataAccessor,
  modelInfo: IDSModelInfo,
  options?: ValidatorOptions
): Promise<IDSValidationReport>;
```

### Facet Checking

```typescript
function checkFacet(facet: IDSFacet, entity: EntityRef, accessor: IFCDataAccessor): boolean;
function filterByFacet(facet: IDSFacet, entities: EntityRef[], accessor: IFCDataAccessor): EntityRef[];
function checkEntityFacet(facet: IDSFacet, entity: EntityRef): boolean;
function checkPropertyFacet(facet: IDSFacet, entity: EntityRef, accessor: IFCDataAccessor): boolean;
```

### Constraint Matching

```typescript
function matchConstraint(constraint: IDSConstraint, value: unknown): boolean;
function formatConstraint(constraint: IDSConstraint): string;
function getConstraintMismatchReason(constraint: IDSConstraint, value: unknown): string;
```

### Translation

```typescript
function createTranslationService(locale: 'en' | 'de' | 'fr'): TranslationService;
```

### Types

```typescript
interface IDSDocument {
  // Parsed IDS document with specifications
}

interface IDSSpecification {
  // A single specification with applicability and requirements
}

interface IDSFacet {
  // Facet definition (entity, property, material, etc.)
}

interface IDSConstraint {
  // Constraint definition (exact value, pattern, range, enumeration)
}

interface IDSValidationReport {
  // Validation results with pass/fail per specification
}

interface IDSEntityResult {
  // Result for a single entity against a specification
}

interface IFCDataAccessor {
  // Abstraction for accessing IFC data during validation
}
```

---

## @ifc-lite/mutations

Property editing with bidirectional change tracking.

### MutablePropertyView

Wraps a PropertyTable with a mutation overlay for non-destructive property editing.

```typescript
class MutablePropertyView {
  constructor(baseTable: PropertyTable | null, modelId: string);

  // Get properties for an entity (with mutations applied)
  getForEntity(entityId: number): PropertySet[];

  // Get a specific property value (with mutations applied)
  getPropertyValue(entityId: number, psetName: string, propName: string): PropertyValue | null;

  // Set a property value (returns the Mutation record)
  setProperty(
    entityId: number,
    psetName: string,
    propName: string,
    value: PropertyValue,
    valueType?: PropertyValueType,
    unit?: string
  ): Mutation;

  // Delete a property
  deleteProperty(entityId: number, psetName: string, propName: string): Mutation | null;

  // Create a new property set
  createPropertySet(
    entityId: number,
    psetName: string,
    properties: Array<{ name: string; value: PropertyValue; type?: PropertyValueType }>
  ): Mutation;

  // Delete a property set
  deletePropertySet(entityId: number, psetName: string): Mutation;

  // Get all recorded mutations
  getMutations(): Mutation[];

  // Check if entity has changes
  hasChanges(entityId?: number): boolean;

  // Count of modified entities
  getModifiedEntityCount(): number;

  // Apply a batch of mutations
  applyMutations(mutations: Mutation[]): void;

  // Export/import mutations as JSON
  exportMutations(): string;
  importMutations(json: string): void;

  // ── Store-level mutations (raw STEP edits) ──────────────────────────

  // Override a positional STEP argument by zero-based index. Used for
  // entities without symbolic attribute names (IfcRectangleProfileDef.XDim,
  // cartesian point coordinates, etc.).
  setPositionalAttribute(
    entityId: number,
    index: number,
    value: IfcAttributeValue,
    skipHistory?: boolean,
  ): Mutation;

  // Read-back of all positional overrides on an entity, keyed by index.
  getPositionalMutationsForEntity(entityId: number): Map<number, IfcAttributeValue> | null;

  // Drop a single positional override (used by undo).
  removePositionalMutation(entityId: number, index: number): void;

  // Create / delete entities in the overlay. Tombstoned entities are
  // skipped during STEP export; overlay-created entities are appended.
  createEntity(type: string, attributes: IfcAttributeValue[]): NewEntity;
  deleteEntity(expressId: number): boolean;
  getNewEntities(): NewEntity[];
  getNewEntity(expressId: number): NewEntity | null;
  isDeleted(expressId: number): boolean;
  getTombstones(): Set<number>;

  // Restore helpers used by viewer undo/redo.
  restoreFromTombstone(expressId: number): boolean;
  restoreNewEntity(entity: NewEntity): void;

  // Seed the express-id allocator from the parsed store's max id (called
  // automatically by StoreEditor's constructor). Subsequent createEntity
  // calls allocate ids strictly above the watermark.
  setExpressIdWatermark(maxExistingId: number): void;
  peekNextExpressId(): number;

  // Reset all mutations
  clear(): void;
}
```

### StoreEditor

High-level facade for editing a parsed `IfcDataStore` via the `MutablePropertyView` overlay. Adds entities, deletes them, edits positional STEP arguments. The underlying store buffer is never mutated — changes accumulate in the overlay and materialise during `StepExporter.export({ applyMutations: true })`.

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

  // Add a new entity to the overlay. Returns a synthetic EntityRef with a
  // freshly-allocated expressId (above the store's watermark).
  addEntity(type: string, attributes: IfcAttributeValue[]): EntityRef;

  // Tombstone an existing entity OR forget an overlay-only one. Returns
  // false if the id is not known.
  removeEntity(expressId: number): boolean;

  // Override a single positional STEP arg by zero-based index.
  setPositionalAttribute(expressId: number, index: number, value: IfcAttributeValue): void;

  // Edit a named root attribute (Name, Description, ObjectType, …).
  setAttribute(expressId: number, attrName: string, value: string): void;

  // Read overlay-created entities.
  getNewEntity(expressId: number): NewEntity | null;
  getNewEntities(): NewEntity[];
}
```

```typescript
// Sentinel byteOffset that flags an EntityRef as overlay-only.
const OVERLAY_BYTE_OFFSET = -1;

interface NewEntity {
  expressId: number;
  type: string;
  attributes: IfcAttributeValue[];
}

// IFC STEP attribute value, as produced by EntityExtractor.extractEntity().
type IfcAttributeValue = string | number | boolean | null | IfcAttributeValue[];
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
| `[1, 2, 3]` | STEP list `(1,2,3)` — recursive |

### ChangeSetManager

Manage named groups of mutations.

```typescript
class ChangeSetManager {
  createChangeSet(name: string): ChangeSet;
  getActiveChangeSet(): ChangeSet | null;
  setActiveChangeSet(id: string | null): void;
  addMutation(mutation: Mutation): void;
  getChangeSet(id: string): ChangeSet | null;
  getAllChangeSets(): ChangeSet[];
  deleteChangeSet(id: string): boolean;
  renameChangeSet(id: string, newName: string): void;
  mergeChangeSets(ids: string[], newName: string): ChangeSet;
  exportChangeSet(id: string): string;
  importChangeSet(json: string): ChangeSet;
  clear(): void;
}
```

### BulkQueryEngine

Query and update entities in bulk.

```typescript
class BulkQueryEngine {
  constructor(
    entities: EntityTable,
    mutationView: MutablePropertyView,
    spatialHierarchy?: SpatialHierarchy | null,
    properties?: PropertyTable | null,
    strings?: { get(idx: number): string } | null
  );

  // Select entities matching criteria
  select(criteria: SelectionCriteria): number[];

  // Preview which entities match the query
  preview(query: BulkQuery): BulkQueryPreview;

  // Execute the bulk update
  execute(query: BulkQuery): BulkQueryResult;
}
```

### CsvConnector

Import property updates from CSV files.

```typescript
class CsvConnector {
  constructor(
    entities: EntityTable,
    mutationView: MutablePropertyView,
    strings?: { get(idx: number): string } | null
  );

  parse(content: string, options?: CsvParseOptions): CsvRow[];
  match(rows: CsvRow[], mapping: DataMapping): MatchResult[];
  generateMutations(matches: MatchResult[], mapping: DataMapping): Mutation[];
  import(content: string, mapping: DataMapping, options?: CsvParseOptions): ImportStats;
  preview(content: string, mapping: DataMapping, options?: CsvParseOptions): {
    rows: CsvRow[]; matches: MatchResult[]; estimatedMutations: number;
  };
  autoDetectMappings(headers: string[]): PropertyMapping[];
}
```

### Types

```typescript
interface Mutation {
  id: string;
  type:
    // Properties
    | 'CREATE_PROPERTY'
    | 'UPDATE_PROPERTY'
    | 'DELETE_PROPERTY'
    | 'CREATE_PROPERTY_SET'
    | 'DELETE_PROPERTY_SET'
    // Quantities
    | 'CREATE_QUANTITY'
    | 'UPDATE_QUANTITY'
    | 'DELETE_QUANTITY'
    // Named attributes (Name, Description, ObjectType, Tag, …)
    | 'UPDATE_ATTRIBUTE'
    // Positional STEP args (XDim on a profile, coords on a point, …)
    | 'UPDATE_POSITIONAL_ATTRIBUTE'
    // Store-level entity churn (StoreEditor / bim.store.*)
    | 'CREATE_ENTITY'
    | 'DELETE_ENTITY';
  timestamp: number;
  modelId: string;
  entityId: number;
  psetName?: string;
  propName?: string;
  // For UPDATE_ATTRIBUTE: the IfcRoot attribute name (e.g. 'Name').
  // For UPDATE_POSITIONAL_ATTRIBUTE: encoded as `@N` where N is the index.
  // For CREATE_ENTITY: the IFC type (e.g. 'IFCCOLUMN').
  attributeName?: string;
  oldValue?: PropertyValue;
  newValue?: PropertyValue;
}

interface ChangeSet {
  id: string;
  name: string;
  createdAt: number;
  mutations: Mutation[];
  applied: boolean;
}

type PropertyValue = string | number | boolean | null | PropertyValue[];

interface SelectionCriteria {
  entityTypes?: number[];
  storeys?: number[];
  propertyFilters?: PropertyFilter[];
  globalIds?: string[];
  expressIds?: number[];
  namePattern?: string;
}

interface BulkQuery {
  select: SelectionCriteria;
  action: BulkAction;
}

interface BulkQueryPreview {
  matchedEntityIds: number[];
  matchedCount: number;
  estimatedMutations: number;
}

interface BulkQueryResult {
  mutations: Mutation[];
  affectedEntityCount: number;
  success: boolean;
  errors?: string[];
}

interface CsvRow {
  [column: string]: string;
}

type MatchStrategy =
  | { type: 'globalId'; column: string }
  | { type: 'expressId'; column: string }
  | { type: 'name'; column: string };

interface DataMapping {
  matchStrategy: MatchStrategy;
  propertyMappings: PropertyMapping[];
}

interface ImportStats {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  mutationsCreated: number;
  errors: string[];
  warnings: string[];
}
```

---

## @ifc-lite/drawing-2d

2D architectural drawing generation from 3D IFC models.

### Drawing2DGenerator

```typescript
class Drawing2DGenerator {
  constructor(options?: DrawingGeneratorOptions);

  // Generate a floor plan
  generateFloorPlan(meshData: MeshData[], options?: FloorPlanOptions): Drawing2D;

  // Generate a section view
  generateSection(meshData: MeshData[], config: SectionConfig): Drawing2D;
}
```

### High-Level Functions

```typescript
function generateFloorPlan(
  meshes: MeshData[],
  elevation: number,
  options?: Partial<GeneratorOptions>
): Promise<Drawing2D>;

function generateSection(
  meshes: MeshData[],
  axis: 'x' | 'z',
  position: number,
  options?: Partial<GeneratorOptions>
): Promise<Drawing2D>;

function createSectionConfig(
  axis: 'x' | 'y' | 'z',
  position: number,
  options?: Partial<Omit<SectionConfig, 'plane'>>
): SectionConfig;
```

### Section Cutting

```typescript
class SectionCutter {
  cut(meshes: MeshData[], plane: Plane): DrawingLine[];
}

function cutMeshesStreaming(
  meshes: AsyncIterable<MeshData>,
  plane: Plane
): AsyncGenerator<DrawingLine[]>;
```

### SVG Export

```typescript
class SVGExporter {
  export(drawing: Drawing2D, options?: SVGExportOptions): string;
}

function exportToSVG(drawing: Drawing2D, options?: SVGExportOptions): string;
```

### Polygon Building

```typescript
class PolygonBuilder {
  build(lines: DrawingLine[]): Polygon[];
}

function simplifyPolygon(polygon: Polygon, tolerance?: number): Polygon;
```

### Edge Extraction

```typescript
class EdgeExtractor {
  extract(meshes: MeshData[], viewDir: Vector3): DrawingLine[];
}

function getViewDirection(preset: ViewPreset): Vector3;
```

### Hidden Line Removal

```typescript
class HiddenLineClassifier {
  classify(lines: DrawingLine[], meshes: MeshData[]): ClassifiedLine[];
}
```

### Hatching

```typescript
class HatchGenerator {
  generate(polygon: Polygon, pattern: HatchPattern): DrawingLine[];
}

const HATCH_PATTERNS: Record<string, HatchPattern>;
function getHatchPattern(materialName: string): HatchPattern;
```

### Styles and Constants

```typescript
const LINE_STYLES: Record<string, LineStyle>;
const COMMON_SCALES: Record<string, number>;
const PAPER_SIZES: Record<string, { width: number; height: number }>;
```

### Symbols

```typescript
function generateDoorSymbol(width: number, swing: number): DrawingLine[];
function generateWindowSymbol(width: number): DrawingLine[];
function generateStairArrow(start: Vector3, end: Vector3): DrawingLine[];
```

### GPU Acceleration

```typescript
class GPUSectionCutter {
  constructor(device: GPUDevice);
  cut(meshes: MeshData[], plane: Plane): Promise<DrawingLine[]>;
}

function isGPUComputeAvailable(): Promise<boolean>;
```

### Graphic Overrides

```typescript
class GraphicOverrideEngine {
  addRule(rule: GraphicOverrideRule): void;
  apply(drawing: Drawing2D): Drawing2D;
}

function createOverrideEngine(preset?: GraphicOverridePreset): GraphicOverrideEngine;

// Built-in presets
const ARCHITECTURAL_PRESET: GraphicOverridePreset;
const FIRE_SAFETY_PRESET: GraphicOverridePreset;
```

### Drawing Sheets

```typescript
function createFrame(options: FrameOptions): DrawingFrame;
function createTitleBlock(options: TitleBlockOptions): TitleBlock;
function renderFrame(frame: DrawingFrame): SVGElement;
function renderTitleBlock(block: TitleBlock): SVGElement;
function renderScaleBar(scale: number, options?: ScaleBarOptions): SVGElement;

const PAPER_SIZE_REGISTRY: Record<string, PaperSize>;
```

### Types

```typescript
interface Drawing2D {
  // Collection of drawing lines, polygons, and metadata
}

interface SectionConfig {
  // Section plane position, direction, and depth
}

interface DrawingLine {
  // Line segment with start, end, style, and layer
}

interface SVGExportOptions {
  // SVG output settings (scale, stroke widths, colors)
}

interface GraphicOverrideRule {
  // Rule matching entities to graphic styles
}

interface GraphicOverridePreset {
  // Named collection of override rules
}

interface DrawingSheet {
  // Sheet layout with frame, title block, and viewports
}
```

---

## @ifc-lite/create

Build valid IFC4 STEP files programmatically with building elements, geometry, property sets, quantities, and materials.

### IfcCreator

Main class for creating IFC files from scratch.

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

  // Building elements (returns expressId)
  addIfcWall(storeyId: number, params: WallParams): number;
  addIfcSlab(storeyId: number, params: SlabParams): number;
  addIfcColumn(storeyId: number, params: ColumnParams): number;
  addIfcBeam(storeyId: number, params: BeamParams): number;
  addIfcStair(storeyId: number, params: StairParams): number;
  addIfcRoof(storeyId: number, params: RoofParams): number;

  // Properties, quantities, materials
  addIfcPropertySet(elementId: number, pset: PropertySetDef): number;
  addIfcElementQuantity(elementId: number, qset: QuantitySetDef): number;
  addIfcMaterial(elementId: number, material: MaterialDef): void;

  // Appearance
  setColor(elementId: number, name: string, rgb: [number, number, number]): void;

  // Generate STEP file
  toIfc(): CreateResult;
}
```

#### ProjectParams

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

#### StoreyParams

```typescript
interface StoreyParams {
  Name?: string;
  Description?: string;
  Elevation: number;
}
```

#### WallParams

```typescript
interface WallParams {
  Start: [number, number, number];
  End: [number, number, number];
  Thickness: number;
  Height: number;
  Name?: string;
  Openings?: RectangularOpening[];
}
```

#### SlabParams

```typescript
interface SlabParams {
  Position: [number, number, number];
  Thickness: number;
  Width?: number;      // X dimension (omit when using Profile)
  Depth?: number;      // Y dimension (omit when using Profile)
  Profile?: [number, number][];  // Arbitrary closed outline
  Name?: string;
  Openings?: RectangularOpening[];
}
```

#### ColumnParams

```typescript
interface ColumnParams {
  Position: [number, number, number];
  Width: number;
  Depth: number;
  Height: number;
  Name?: string;
}
```

#### BeamParams

```typescript
interface BeamParams {
  Start: [number, number, number];
  End: [number, number, number];
  Width: number;
  Height: number;
  Name?: string;
}
```

#### StairParams

```typescript
interface StairParams {
  Position: [number, number, number];
  NumberOfRisers: number;
  RiserHeight: number;
  TreadLength: number;
  Width: number;
  Direction?: number;  // Angle in radians, 0 = +X
  Name?: string;
}
```

#### RoofParams

```typescript
interface RoofParams {
  Position: [number, number, number];
  Width: number;
  Depth: number;
  Thickness: number;
  Slope?: number;  // Angle in radians, 0 = flat
  Name?: string;
}
```

#### RectangularOpening

```typescript
interface RectangularOpening {
  Width: number;
  Height: number;
  Position: [number, number, number];  // Relative to host element
  Name?: string;
}
```

#### PropertySetDef

```typescript
interface PropertySetDef {
  Name: string;
  Properties: Array<{
    Name: string;
    NominalValue: string | number | boolean;
    Type?: 'IfcLabel' | 'IfcText' | 'IfcReal' | 'IfcInteger' | 'IfcBoolean';
  }>;
}
```

#### QuantitySetDef

```typescript
interface QuantitySetDef {
  Name: string;
  Quantities: Array<{
    Name: string;
    Value: number;
    Kind: 'IfcQuantityLength' | 'IfcQuantityArea' | 'IfcQuantityVolume'
        | 'IfcQuantityCount' | 'IfcQuantityWeight';
  }>;
}
```

#### MaterialDef

```typescript
interface MaterialDef {
  Name: string;
  Category?: string;
  Layers?: Array<{
    Name: string;
    Thickness: number;
    Category?: string;
    IsVentilated?: boolean;
  }>;
}
```

#### CreateResult

```typescript
interface CreateResult {
  content: string;
  entities: Array<{ expressId: number; type: string; Name?: string }>;
  stats: { entityCount: number; fileSize: number };
}
```

### In-Store Builders

For editing an **already-parsed** `IfcDataStore` instead of building a new file from scratch, the package exposes anchored builders that emit a complete sub-graph into a `StoreEditor` overlay.

#### addColumnToStore

Add an `IfcColumn` (with placement, profile, extruded solid, representation, product shape, and rel-contained-in-spatial-structure) to an existing parsed model.

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

```typescript
function addColumnToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: ColumnInStoreParams,
): ColumnBuildResult;

interface ColumnInStoreParams {
  Position: [number, number, number];  // Storey-local metres
  Width: number;
  Depth: number;
  Height: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

interface ColumnBuildResult {
  columnId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  /** The IfcRelContainedInSpatialStructure linking the column to its storey. */
  relContainedId: number;
}
```

#### resolveSpatialAnchor

Walks a parsed `IfcDataStore` for the references every in-store builder needs. Throws if any of `IfcOwnerHistory`, the 'Body' representation context, or the storey's `IfcLocalPlacement` can't be resolved.

```typescript
function resolveSpatialAnchor(
  store: IfcDataStore,
  storeyExpressId: number,
): SpatialAnchor;

interface SpatialAnchor {
  /** IfcOwnerHistory expressId — referenced by every IfcRoot. */
  ownerHistoryId: number;
  /** IfcGeometricRepresentationSubContext for 'Body' (or its parent context as fallback). */
  bodyContextId: number;
  /** The target IfcBuildingStorey expressId. */
  storeyId: number;
  /** The IfcLocalPlacement that the storey itself sits on. */
  storeyPlacementId: number;
}
```

---

## @ifc-lite/codegen

Code generation from IFC EXPRESS schemas.

### Overview

Generates TypeScript entity types from EXPRESS schema files. Used to produce the 876+ IFC4X3 entity definitions used by the parser. This is primarily a build-time tool, not used at runtime.

```typescript
// Build-time usage (typically invoked via package scripts)
// Reads EXPRESS schema (.exp) files and outputs TypeScript type definitions
// for all IFC entity types, enumerations, and select types.
```

---

## @ifc-lite/server-bin

Pre-built server binary distribution package.

### Overview

Distributes pre-compiled `ifc-lite-server` binaries for deployment without requiring a Rust toolchain.

**Supported platforms:**

| Platform         | Architecture |
|------------------|-------------|
| `linux-x64`      | x86_64      |
| `linux-arm64`    | aarch64     |
| `linux-x64-musl` | x86_64 (musl libc) |
| `darwin-x64`     | x86_64 (macOS) |
| `darwin-arm64`   | aarch64 (macOS Apple Silicon) |
| `win32-x64`      | x86_64 (Windows) |
