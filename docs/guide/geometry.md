# Geometry Processing

Guide to geometry extraction and processing in IFClite.

## Overview

All geometry is produced by a single Rust pipeline (`produce_element_meshes`
in the processing crate), whether it runs through the browser WASM build, the
worker pool, or a native host. Every consumer therefore gets identical
per-element meshes, and fixes to the mesher land once for all paths.

IFClite processes IFC geometry through a streaming pipeline:

```mermaid
flowchart TB
    subgraph Input["IFC Geometry Types"]
        Extrusion["ExtrudedAreaSolid"]
        Brep["FacetedBrep"]
        Clipping["BooleanClipping"]
        Mapped["MappedItem"]
    end

    subgraph Router["Geometry Router"]
        Detect["Type Detection"]
        Select["Processor Selection"]
    end

    subgraph Processors["Specialized Processors"]
        ExtProc["Extrusion Processor"]
        BrepProc["Brep Processor"]
        CSGProc["CSG Processor"]
        MapProc["Instance Processor"]
    end

    subgraph Output["GPU-Ready Output"]
        Mesh["Triangle Mesh"]
        Buffers["Vertex Buffers"]
    end

    Input --> Router
    Router --> Processors
    Extrusion --> ExtProc
    Brep --> BrepProc
    Clipping --> CSGProc
    Mapped --> MapProc
    Processors --> Output

    style Input fill:#6366f1,stroke:#312e81,color:#fff
    style Router fill:#2563eb,stroke:#1e3a8a,color:#fff
    style Processors fill:#10b981,stroke:#064e3b,color:#fff
    style Output fill:#a855f7,stroke:#581c87,color:#fff
```

## Tessellation Quality

Curved geometry (swept pipes, cylinders, fillets, NURBS patches) is
approximated with straight segments. The detail level is selectable per
`GeometryProcessor` — no WASM rebuild needed:

| Level | Curved-surface segment density | Profile circles (opening cutters / caps) | Use case |
|-------|-------------------------------|------------------------------------------|----------|
| `'lowest'` | ×0.25 | max 8 segments | Maximum throughput, previews |
| `'low'` | ×0.5 | max 16 segments | Mobile, large federated models |
| `'medium'` (default) | ×1 — historical densities | 36 segments | General use |
| `'high'` | ×2 | 36 (never finer) | Smooth pipes / cylinders |
| `'highest'` | ×4 | 36 (never finer) | Close-up curved detail |

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

// At construction…
const geometry = new GeometryProcessor({ tessellationQuality: 'high' });
await geometry.init();

// …or at runtime, BEFORE processing (already-emitted meshes are not
// regenerated — reload the model to apply a new level):
geometry.setTessellationQuality('low');

const result = await geometry.process(new Uint8Array(buffer));
```

The same knob exists on the raw WASM API for consumers driving
`processGeometryBatch` directly:

```typescript
import { IfcAPI } from '@ifc-lite/wasm';

const api = new IfcAPI();
api.setTessellationQuality('highest'); // applies to subsequent batches
```

**Performance trade-off.** Triangle count and processing time on
curved-heavy models scale roughly with the density multiplier: `'highest'`
can quadruple the triangles of a pipe-rack model, `'lowest'` quarters them.
Boxy architectural models (extrusions, breps) are barely affected — only
curved tessellation scales.

**Guarantees:**

- Leaving the level unset (or passing `'medium'` / `null`) produces output
  **byte-for-byte identical** to previous releases — upgrading is safe.
- Segment counts rise monotonically with the level (never fewer triangles
  at a higher level).
- Profile-plane outlines (extruded caps and opening cutters) never get
  *finer* than `'medium'` — denser opening circles only multiply earcut
  cap-bridge slivers on plates with bolt holes. They do coarsen below
  `'medium'` for preview levels.
- WASM paths only (main-thread, streaming and worker pool); the native
  Tauri pipeline does not consume the level yet.

## Mesh Data Structure

```mermaid
classDiagram
    class MeshData {
        +number expressId
        +string? ifcType
        +Float32Array positions
        +Float32Array normals
        +Uint32Array indices
        +Float32Array? uvs
        +number[] color
        +number[]? origin
    }

    class GeometryResult {
        +MeshData[] meshes
        +number totalTriangles
        +number totalVertices
        +CoordinateInfo coordinateInfo
    }

    class CoordinateInfo {
        +Vec3 originShift
        +AABB originalBounds
        +AABB shiftedBounds
        +boolean hasLargeCoordinates
    }

    GeometryResult "1" --> "*" MeshData
    GeometryResult "1" --> "1" CoordinateInfo
```

!!! warning "Winding order is not outward-guaranteed"
    Triangle winding in IFC-derived meshes is unreliable by design: source
    breps and CSG results do not guarantee outward-facing triangles. Renderers
    must draw double-sided (`cullMode: 'none'` / `DoubleSide`) and must not use
    winding for front/back-face decisions; shade with
    `abs(dot(normal, viewDir))` or depth testing instead. The bundled
    `@ifc-lite/renderer` already does this.

### Accessing Mesh Data

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const geometry = new GeometryProcessor();
await geometry.init();

const result = await geometry.process(new Uint8Array(buffer));

// Get all meshes
for (const mesh of result.meshes) {
  console.log(`Entity #${mesh.expressId}:`);
  console.log(`  Vertices: ${mesh.positions.length / 3}`);
  console.log(`  Triangles: ${mesh.indices.length / 3}`);
  console.log(`  Color: rgba(${mesh.color.join(', ')})`);
}

// Find mesh by entity ID
const wallMesh = result.meshes.find(m => m.expressId === wallId);

// Precomputed model bounds (from coordinate info on the result)
const bounds = result.coordinateInfo.shiftedBounds;
console.log(`Model bounds:`, bounds);
```

### Drilling from a Mesh Back to its Source Item

An element's `expressId` names the wall; it does not name the piece of the wall
you just clicked. `MeshData.geometryItemId` does. It is the **STEP express id of
the `IfcRepresentationItem` the mesh was tessellated from**, so on a wall built
from several solids each mesh names its own `IfcExtrudedAreaSolid`,
`IfcFacetedBrep` or `IfcBooleanResult`. Because it is a STEP instance name, it resolves
against the same entity index as any other id, so you can read the source line
back out of the file:

```typescript
import type { MeshData } from '@ifc-lite/geometry';

/** The raw STEP text of the representation item a mesh was tessellated from. */
function sourceItemText(mesh: MeshData): string | undefined {
  // Absent is a real state; see "When it is absent" below. It is never `0`.
  if (mesh.geometryItemId === undefined) return undefined;

  // Representation items are indexed in `entityIndex.byId` like every other
  // entity. They are NOT in the entity TABLE (the columnar parser classifies
  // them as skip-category and never materialises them), so
  // `store.entities.getTypeName(...)` has nothing to return for one. Take the
  // type off the ref instead.
  const ref = store.entityIndex.byId.get(mesh.geometryItemId);
  if (!ref) return undefined;

  console.log(`#${mesh.expressId} came from #${ref.expressId} (${ref.type})`);
  return store.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
}

for (const mesh of result.meshes) {
  const text = sourceItemText(mesh);
  if (text) console.log(text);
}
```

`geometryItemId` is **disjoint from `materialId`**, the other source id on
`MeshData`. `materialId` is an `IfcMaterial` express id, set on the meshes that
slice a wall or slab by material layer. The two are never both set, and they
name different classes of entity, so neither is a fallback for the other:
following `materialId` as though it were a representation item lands on the
wrong entity, which is exactly the confusion the split fixed (#3199).

#### When it is absent

`geometryItemId` is `undefined` when there is no id to carry, never `0`. STEP
instance names start at `#1`, so a zero can only be a producer's own "no
reference" sentinel, and the pipeline filters it to absent at the single place
both source ids are set.

Absence means **"no item identity is available here"**, not "this geometry has
no source item". The item existed; the mesh you are holding was merged from more
than one of them, so no single id describes it. The cases:

- **The single merged mesh fallback.** The element was emitted as one mesh for
  its whole body rather than one mesh per representation item.
- **The cached `IfcMappedItem` path.** A representation map's items were merged
  into one template, so the template names none of them individually.
- **A colour-merged batch.** Many entities' vertices share one `MeshData`,
  identified per-vertex by `entityIds`; one item id cannot name many entities'
  geometry.

A material-layer slice is a fourth kind of absence with a different reading: it
carries `materialId` instead, so the identity is present but is a material's,
not an item's.

## Streaming Geometry

Process geometry incrementally for large files:

```mermaid
sequenceDiagram
    participant Parser
    participant Processor as Geometry Processor
    participant Collector as Mesh Collector
    participant GPU as WebGPU

    loop Batch Processing
        Parser->>Processor: Entity batch
        Processor->>Processor: Triangulate
        Processor->>Collector: Mesh batch
        Collector->>GPU: Upload buffers
        Note over GPU: Render visible meshes
    end
```

### Streaming Example

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';

const geometry = new GeometryProcessor();
await geometry.init();

const renderer = new Renderer(canvas);
await renderer.init();

// Stream geometry progressively
for await (const event of geometry.processStreaming(new Uint8Array(buffer))) {
  switch (event.type) {
    case 'start':
      console.log('Starting geometry extraction');
      break;

    case 'batch':
      // Upload meshes to GPU as they arrive
      renderer.addMeshes(event.meshes, true);  // isStreaming = true

      // Render current state
      renderer.render();
      console.log(`Meshes so far: ${event.totalSoFar}`);
      break;

    case 'complete':
      // Finalize rendering
      renderer.fitToView();
      console.log(`Complete: ${event.totalMeshes} meshes`);
      break;
  }
}
```

## Parallel and Adaptive Processing

On multi-core machines with `SharedArrayBuffer` available (a
cross-origin-isolated page), the processor can fan geometry out to a pool of
Web Workers, each with its own WASM instance processing a disjoint slice of
the element list. Batches are yielded as they arrive from any worker:

```typescript
// Explicit worker-pool streaming
for await (const event of geometry.processParallel(new Uint8Array(buffer))) {
  if (event.type === 'batch') renderer.addMeshes(event.meshes, true);
}
```

`processAdaptive()` is the recommended entry point: it picks the best path
automatically. Small files (below a 2 MB threshold by default) are processed
in one shot for instant display; larger files use the parallel worker pool
when available, falling back to single-worker streaming otherwise:

```typescript
for await (const event of geometry.processAdaptive(new Uint8Array(buffer))) {
  switch (event.type) {
    case 'batch':
      // Note: multiple meshes may share an expressId (one per material/part);
      // group by expressId for per-element rendering or picking.
      renderer.addMeshes(event.meshes, true);
      break;
    case 'complete':
      renderer.fitToView();
      break;
  }
}
```

The worker count is chosen by a cores/memory heuristic; geometry output is
identical regardless of the count (workers process deterministic, disjoint
slices).

## Coordinate Handling

IFC files often use large georeferenced coordinates that cause precision issues:

```mermaid
flowchart LR
    subgraph Problem["Problem"]
        Large["Large Coordinates<br/>(6-7 digit values)"]
        Precision["Float32 Precision Loss"]
        Jitter["Visual Jitter"]
        Large --> Precision --> Jitter
    end

    subgraph Solution["Solution"]
        Detect["Detect Large Coords"]
        Shift["Auto-Shift to Origin"]
        Store["Store Offset"]
        Detect --> Shift --> Store
    end

    Problem --> Solution

    style Problem fill:#dc2626,stroke:#7f1d1d,color:#fff
    style Solution fill:#16a34a,stroke:#14532d,color:#fff
```

### Auto Origin Shift

The geometry processor automatically handles large coordinates:

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const geometry = new GeometryProcessor();
await geometry.init();

const result = await geometry.process(new Uint8Array(buffer));

// Access the computed shift from coordinate info (returned on the result)
const coordInfo = result.coordinateInfo;
if (coordInfo?.originShift) {
  console.log(`Origin shifted by:`, coordInfo.originShift);
  // { x: 487234.5, y: 5234891.2, z: 0 }
}

// Convert local coordinates back to world
function toWorldCoords(localPos: Vector3, shift: Vector3): Vector3 {
  return {
    x: localPos.x + shift.x,
    y: localPos.y + shift.y,
    z: localPos.z + shift.z
  };
}
```

## Geometry Processors

### Extrusion Processor

Handles `IfcExtrudedAreaSolid` entities:

```mermaid
flowchart LR
    subgraph Input
        Profile["2D Profile"]
        Direction["Extrusion Direction"]
        Depth["Extrusion Depth"]
    end

    subgraph Process
        Triangulate["Triangulate Profile<br/>(earcutr)"]
        Extrude["Generate Side Faces"]
        Cap["Create End Caps"]
    end

    subgraph Output
        Mesh["3D Mesh"]
    end

    Profile --> Triangulate
    Triangulate --> Extrude
    Direction --> Extrude
    Depth --> Extrude
    Extrude --> Cap
    Cap --> Mesh

    style Input fill:#6366f1,stroke:#312e81,color:#fff
    style Process fill:#2563eb,stroke:#1e3a8a,color:#fff
    style Output fill:#a855f7,stroke:#581c87,color:#fff
```

### Brep Processor

Handles `IfcFacetedBrep` (and tessellated face-set) entities in Rust. Each
face is projected to its plane and triangulated: simple quads take a fast fan
path, faces with holes go through polygon triangulation with hole support
(falling back to a fan if that fails).

### Boolean Operations

Handles `IfcBooleanClippingResult` and opening voids (`IfcRelVoidsElement`).
Void cutting is a single exact-CSG path in the Rust kernel: boolean
differences are evaluated with exact arithmetic predicates, so opening cuts
are watertight rather than approximated.

```mermaid
flowchart LR
    First["First Operand"]
    Second["Second Operand"]
    Op["Boolean Operation<br/>(Difference/Union/Intersection)"]
    Result["Result Mesh"]

    First --> Op
    Second --> Op
    Op --> Result

    style First fill:#6366f1,stroke:#312e81,color:#fff
    style Second fill:#6366f1,stroke:#312e81,color:#fff
    style Op fill:#2563eb,stroke:#1e3a8a,color:#fff
    style Result fill:#a855f7,stroke:#581c87,color:#fff
```

## Batching

The renderer automatically groups geometry by colour into a small number of
batched draw calls (one `BatchedMesh` per colour group), so a model with many
repeated elements still renders in a handful of draws — no manual step:

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const geometry = new GeometryProcessor();
await geometry.init();

const result = await geometry.process(new Uint8Array(buffer));

// The renderer batches by colour when you load the meshes.
renderer.loadGeometry(result);
```

In addition, repeated opaque geometry (e.g. Tekla-style bolt/part repetition)
can be routed to a GPU-instancing path: the streaming batch events carry
packed instanced shards when the processor's `enableInstancing` option is on
(the default). Federated multi-model loads should pass
`enableInstancing: false`, since the renderer's instanced path is
primary-model only. See the [Rendering Guide](rendering.md) for how shards are
uploaded.

### Item Ids on Instanced Occurrences

Instanced occurrences carry `geometryItemId` too, so instancing is no longer a
reason to lose the drill-to-source link. **Do not turn instancing off to get
item ids**: that trade no longer exists, and it costs you the draw-call win for
nothing.

On the wire the id rides the shard: `decodeInstancedShard` returns each
occurrence with an optional `itemId`, and the renderer's `prepareInstancedRender`
turns that into a per-template `itemIds` column parallel to `entityIds`. An
occurrence that renders flat because it fell below the instancing threshold
keeps its id as an ordinary `MeshData.geometryItemId`, so both halves of a model
answer the same question.

`DecodedInstancedShard.carriesItemIds` is how you tell **"this shard declares no
ids at all"** from **"this one piece has no item"**:

```typescript
import { decodeInstancedShard } from '@ifc-lite/geometry';

const shard = decodeInstancedShard(bytes);

if (!shard.carriesItemIds) {
  // Nothing in this shard names an item. Every occurrence's `itemId` is
  // undefined for the SAME reason, so don't report per-piece "unknown source".
} else {
  for (const occurrence of shard.instances) {
    // Here an undefined `itemId` is about this occurrence, not the shard.
    if (occurrence.itemId !== undefined) {
      console.log(`#${occurrence.entityId} <- item #${occurrence.itemId}`);
    }
  }
}
```

The flag is derived from the shard's declared instance-record stride, and the
encoder derives that stride from the data (it only widens the record when some
occurrence actually names an item), so `false` genuinely means "no occurrence
here has one", not "this build cannot see them".

!!! warning "A warm cache can show absence that is about the cache"
    Instanced shards are persisted into the binary cache as raw wire bytes and
    replayed verbatim, without a re-encode. A shard written by a build from
    before item ids shipped is a **v1 shard**: it declares the narrow stride, so
    `carriesItemIds` is `false` and every occurrence in it reports no item,
    even though the current pipeline would produce ids for that same model. The
    decoders read such a shard rather than refusing it, so a host with a warm
    cache can see absence caused by the cache rather than by the geometry.

    In this release those entries are invalidated anyway: the cache
    `FORMAT_VERSION` moves 15 → 16, so every entry misses once and re-meshes.
    That bump is not about reading old shards — it is about not handing NEW ones
    to an OLD bundle. The cache key carries `FORMAT_VERSION`, and a build from
    before this change refuses any shard version but 1 while the streaming
    loader swallows the error, which would silently drop every instanced
    occurrence under deploy skew or a rollback. After the one re-mesh, a warm
    cache holds v2 shards wherever an occurrence actually names an item. A
    batch where none does is still written at the base stride as version 1,
    so re-meshing does not turn every shard into a v2 one.

## Performance Optimization

### Memory-Efficient Processing

Use streaming for large files:

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const geometry = new GeometryProcessor();
await geometry.init();

// Stream geometry in batches
for await (const event of geometry.processStreaming(new Uint8Array(buffer), undefined, 50)) {
  if (event.type === 'batch') {
    renderer.addMeshes(event.meshes, true);
    console.log(`Meshes so far: ${event.totalSoFar}`);
  }
}
```

### Filtering Geometry

To only render specific entity types, filter the meshes after processing:

```typescript
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';

const parser = new IfcParser();
const store = await parser.parseColumnar(buffer);

// Get expressIds for types you want
const wantedIds = new Set([
  ...(store.entityIndex.byType.get('IFCWALL') ?? []),
  ...(store.entityIndex.byType.get('IFCDOOR') ?? []),
  ...(store.entityIndex.byType.get('IFCWINDOW') ?? [])
]);

// Process all geometry
const geometry = new GeometryProcessor();
await geometry.init();
const result = await geometry.process(new Uint8Array(buffer));

// Filter meshes
const filteredMeshes = result.meshes.filter(m => wantedIds.has(m.expressId));
renderer.loadGeometry(filteredMeshes);
```

## Geometry Statistics

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const geometry = new GeometryProcessor();
await geometry.init();

const result = await geometry.process(new Uint8Array(buffer));

// Totals are precomputed on the result
console.log('Geometry Statistics:');
console.log(`  Total meshes: ${result.meshes.length}`);
console.log(`  Total triangles: ${result.totalTriangles}`);
console.log(`  Total vertices: ${result.totalVertices}`);
```

## Next Steps

- [Rendering Guide](rendering.md) - Display geometry with WebGPU
- [Parsing Guide](parsing.md) - Parse options and streaming
- [API Reference](../api/typescript.md) - Complete API docs
