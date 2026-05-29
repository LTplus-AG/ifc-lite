# Geometry Processing

Guide to geometry extraction and processing in IFClite.

## Overview

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

## Geometry Quality Modes

| Mode | Curve Segments | Use Case |
|------|---------------|----------|
| `FAST` | 8 | Quick preview, mobile devices |
| `BALANCED` | 16 | Default, good quality/performance |
| `HIGH` | 32 | Maximum quality, detailed models |

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const geometry = new GeometryProcessor();
await geometry.init();

// Process with default quality
const result = await geometry.process(new Uint8Array(buffer));

// Note: Quality settings are configured in the WASM module
// For custom quality, rebuild with different curve subdivision settings
```

## Mesh Data Structure

```mermaid
classDiagram
    class Mesh {
        +number expressId
        +Float32Array positions
        +Float32Array normals
        +Uint32Array indices
        +Float32Array? uvs
        +number[] color
        +Matrix4 transform
    }

    class GeometryResult {
        +Mesh[] meshes
        +BoundingBox bounds
        +number triangleCount
        +number vertexCount
    }

    class BoundingBox {
        +Vector3 min
        +Vector3 max
        +Vector3 center
        +Vector3 size
    }

    GeometryResult "1" --> "*" Mesh
    GeometryResult "1" --> "1" BoundingBox
```

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

// Calculate bounds from meshes
const bounds = calculateBounds(result.meshes);
console.log(`Model bounds:`, bounds);
```

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
      console.log(`Progress: ${event.progress}%`);
      break;

    case 'complete':
      // Finalize rendering
      renderer.fitToView();
      console.log(`Complete: ${event.totalMeshes} meshes`);
      break;
  }
}
```

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

// Access the computed shift from coordinate info
const coordInfo = geometry.getCoordinateInfo();
if (coordInfo?.shift) {
  console.log(`Origin shifted by:`, coordInfo.shift);
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

Handles `IfcFacetedBrep` entities:

```typescript
// Brep processing is straightforward - faces are already triangulated
// in most cases, or need simple fan triangulation

const brepMesh = processBrep({
  faces: brepEntity.faces,
  vertices: brepEntity.vertices
});
```

### Boolean Operations

Handles `IfcBooleanClippingResult`:

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

## Custom Geometry Processing

Extend geometry processing for custom needs:

```typescript
import { GeometryProcessor, ProcessorRegistry } from '@ifc-lite/geometry';

// Create custom processor
class CustomProfileProcessor extends GeometryProcessor {
  canProcess(entity: Entity): boolean {
    return entity.type === 'IFCARBITRARYCLOSEDPROFILEDEF';
  }

  process(entity: Entity): Mesh {
    // Custom triangulation logic
    const points = this.extractPoints(entity);
    const triangles = this.triangulate(points);
    return this.buildMesh(triangles);
  }
}

// Register processor
ProcessorRegistry.register(new CustomProfileProcessor());
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
    console.log(`Progress: ${event.progress}%`);
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
renderer.loadGeometry({ meshes: filteredMeshes });
```

## Geometry Statistics

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const geometry = new GeometryProcessor();
await geometry.init();

const result = await geometry.process(new Uint8Array(buffer));

// Calculate statistics from meshes
let totalTriangles = 0;
let totalVertices = 0;

for (const mesh of result.meshes) {
  totalTriangles += mesh.indices.length / 3;
  totalVertices += mesh.positions.length / 3;
}

console.log('Geometry Statistics:');
console.log(`  Total meshes: ${result.meshes.length}`);
console.log(`  Total triangles: ${totalTriangles}`);
console.log(`  Total vertices: ${totalVertices}`);
```

## Next Steps

- [Rendering Guide](rendering.md) - Display geometry with WebGPU
- [Parsing Guide](parsing.md) - Parse options and streaming
- [API Reference](../api/typescript.md) - Complete API docs
