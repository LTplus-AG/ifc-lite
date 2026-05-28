# Geometry Pipeline

Detailed architecture of geometry processing in IFClite.

## Overview

The geometry pipeline transforms IFC shape representations into GPU-ready triangle meshes:

```mermaid
flowchart TB
    subgraph Input["IFC Geometry"]
        Extrusion["IfcExtrudedAreaSolid"]
        Brep["IfcFacetedBrep"]
        Boolean["IfcBooleanResult"]
        Mapped["IfcMappedItem"]
        Surface["IfcSurfaceModel"]
    end

    subgraph Router["Geometry Router"]
        Detect["Type Detection"]
        Select["Processor Selection"]
    end

    subgraph Processors["Specialized Processors"]
        ExtProc["ExtrusionProcessor"]
        BrepProc["BrepProcessor"]
        BoolProc["BooleanProcessor"]
        MapProc["MappedItemProcessor"]
        SurfProc["SurfaceProcessor"]
    end

    subgraph Output["Output"]
        Mesh["Triangle Mesh"]
    end

    Input --> Router --> Processors --> Output
```

## Geometry Representation Types

### IFC Geometry Hierarchy

```mermaid
classDiagram
    class IfcRepresentationItem {
        <<abstract>>
    }

    class IfcSolidModel {
        <<abstract>>
    }

    class IfcSweptAreaSolid {
        +IfcProfileDef SweptArea
        +IfcAxis2Placement3D Position
    }

    class IfcExtrudedAreaSolid {
        +IfcDirection ExtrudedDirection
        +IfcPositiveLengthMeasure Depth
    }

    class IfcFacetedBrep {
        +IfcClosedShell Outer
    }

    class IfcBooleanResult {
        +IfcBooleanOperand FirstOperand
        +IfcBooleanOperand SecondOperand
        +IfcBooleanOperator Operator
    }

    IfcRepresentationItem <|-- IfcSolidModel
    IfcSolidModel <|-- IfcSweptAreaSolid
    IfcSweptAreaSolid <|-- IfcExtrudedAreaSolid
    IfcSolidModel <|-- IfcFacetedBrep
    IfcSolidModel <|-- IfcBooleanResult
```

### Coverage by Type

| Geometry Type | Coverage | Notes |
|---------------|----------|-------|
| IfcExtrudedAreaSolid | Full | Most common |
| IfcFacetedBrep | Full | Pre-triangulated |
| IfcBooleanClippingResult | Partial | CSG operations |
| IfcMappedItem | Full | Instancing |
| IfcSurfaceModel | Partial | Surface meshes |
| IfcTriangulatedFaceSet | Full | IFC4 triangles |

## Extrusion Processing

### Pipeline

```mermaid
flowchart TB
    subgraph Input["Input"]
        Profile["2D Profile"]
        Direction["Extrusion Direction"]
        Depth["Depth"]
        Position["Placement"]
    end

    subgraph Profile["Profile Processing"]
        Extract["Extract Outer Boundary"]
        Holes["Extract Inner Boundaries"]
        Flatten["Flatten to 2D"]
    end

    subgraph Triangulate["Triangulation"]
        Earcut["earcutr Algorithm"]
        Bottom["Bottom Face"]
        Top["Top Face"]
    end

    subgraph Extrude["Extrusion"]
        Walls["Generate Side Walls"]
        Join["Join Vertices"]
        Normals["Compute Normals"]
    end

    subgraph Output["Output"]
        Mesh["Triangle Mesh"]
    end

    Input --> Profile --> Triangulate --> Extrude --> Output
```

### Profile Types

```mermaid
classDiagram
    class IfcProfileDef {
        <<abstract>>
        +IfcProfileTypeEnum ProfileType
        +IfcLabel ProfileName
    }

    class IfcRectangleProfileDef {
        +IfcPositiveLengthMeasure XDim
        +IfcPositiveLengthMeasure YDim
    }

    class IfcCircleProfileDef {
        +IfcPositiveLengthMeasure Radius
    }

    class IfcArbitraryClosedProfileDef {
        +IfcCurve OuterCurve
    }

    class IfcArbitraryProfileDefWithVoids {
        +SET~IfcCurve~ InnerCurves
    }

    IfcProfileDef <|-- IfcRectangleProfileDef
    IfcProfileDef <|-- IfcCircleProfileDef
    IfcProfileDef <|-- IfcArbitraryClosedProfileDef
    IfcArbitraryClosedProfileDef <|-- IfcArbitraryProfileDefWithVoids
```

### Earcut Algorithm

```mermaid
flowchart LR
    subgraph Input["Input"]
        Poly["Polygon with Holes"]
    end

    subgraph Process["earcutr Process"]
        Flatten["Flatten coordinates"]
        Ear["Find ear"]
        Clip["Clip ear"]
        Repeat["Repeat until done"]
    end

    subgraph Output["Output"]
        Indices["Triangle indices"]
    end

    Input --> Process --> Output
```

```rust
use earcutr::earcut;

fn triangulate_profile(
    outer: &[Point2],
    holes: &[Vec<Point2>]
) -> Vec<u32> {
    // Flatten to coordinate array
    let mut coords: Vec<f64> = Vec::new();
    let mut hole_indices: Vec<usize> = Vec::new();

    // Add outer boundary
    for p in outer {
        coords.push(p.x);
        coords.push(p.y);
    }

    // Add holes
    for hole in holes {
        hole_indices.push(coords.len() / 2);
        for p in hole {
            coords.push(p.x);
            coords.push(p.y);
        }
    }

    // Triangulate
    earcut(&coords, &hole_indices, 2)
        .unwrap()
        .into_iter()
        .map(|i| i as u32)
        .collect()
}
```

## Brep Processing

### FacetedBrep Pipeline

```mermaid
flowchart TB
    subgraph Input["IfcFacetedBrep"]
        Shell["IfcClosedShell"]
        Faces["IfcFace[]"]
    end

    subgraph Process["Processing"]
        Extract["Extract face bounds"]
        Orient["Check orientation"]
        Triangulate["Fan triangulation"]
        Normals["Compute normals"]
    end

    subgraph Output["Output"]
        Mesh["Triangle Mesh"]
    end

    Input --> Process --> Output
```

### Face Triangulation

```mermaid
graph LR
    subgraph Polygon["Face Polygon"]
        V0["V0"]
        V1["V1"]
        V2["V2"]
        V3["V3"]
        V4["V4"]
    end

    subgraph Triangles["Fan Triangulation"]
        T1["V0-V1-V2"]
        T2["V0-V2-V3"]
        T3["V0-V3-V4"]
    end

    V0 --> T1
    V1 --> T1
    V2 --> T1
    V0 --> T2
    V2 --> T2
    V3 --> T2
```

## Boolean Operations

### CSG Pipeline

```mermaid
flowchart TB
    subgraph Input["Input"]
        First["First Operand"]
        Second["Second Operand"]
        Op["Operator"]
    end

    subgraph Prepare["Preparation"]
        Mesh1["Triangulate First"]
        Mesh2["Triangulate Second"]
    end

    subgraph CSG["CSG Operation"]
        Intersect["Find Intersections"]
        Classify["Classify Triangles"]
        Combine["Combine Result"]
    end

    subgraph Output["Output"]
        Result["Result Mesh"]
    end

    Input --> Prepare --> CSG --> Output
```

### Boolean Operators

| Operator | Description | Common Use |
|----------|-------------|------------|
| DIFFERENCE | A - B | Wall openings |
| UNION | A + B | Composite shapes |
| INTERSECTION | A ∩ B | Clipping |

## Coordinate Transformations

### Placement Stack

```mermaid
flowchart TB
    subgraph Stack["Transformation Stack"]
        World["World Origin"]
        Site["Site Placement"]
        Building["Building Placement"]
        Storey["Storey Placement"]
        Element["Element Placement"]
        Local["Local Placement"]
    end

    subgraph Matrix["Combined Matrix"]
        M["4x4 Transform"]
    end

    World --> Site --> Building --> Storey --> Element --> Local
    Local --> M
```

### Matrix Operations

```rust
use nalgebra::{Matrix4, Point3, Vector3};

fn compute_transform(placements: &[Placement]) -> Matrix4<f64> {
    let mut result = Matrix4::identity();

    for placement in placements {
        let local = Matrix4::new_translation(&placement.location)
            * Matrix4::from_axis_angle(&placement.axis, placement.angle);
        result = result * local;
    end

    result
}

fn transform_point(point: Point3<f64>, matrix: &Matrix4<f64>) -> Point3<f64> {
    matrix.transform_point(&point)
}
```

### Large Coordinate Handling

```mermaid
flowchart LR
    subgraph Problem["Problem"]
        Large["Large Coords<br/>(487234.5, 5234891.2, 0)"]
        Float32["Float32 Precision<br/>(7 digits)"]
        Jitter["Visual Jitter"]
    end

    subgraph Solution["Solution"]
        Detect["Detect large values"]
        Shift["Compute origin shift"]
        Apply["Apply to all vertices"]
        Store["Store offset"]
    end

    Problem --> Solution
```

```typescript
function computeOriginShift(bounds: BoundingBox): Vector3 {
  const threshold = 10000; // Shift if > 10km from origin

  if (Math.abs(bounds.center.x) > threshold ||
      Math.abs(bounds.center.y) > threshold) {
    return {
      x: -bounds.center.x,
      y: -bounds.center.y,
      z: 0
    };
  }

  return { x: 0, y: 0, z: 0 };
}
```

## Quality Modes

### Curve Discretization

```mermaid
graph LR
    subgraph Circle["Circle Approximation"]
        Fast["FAST: 8 segments"]
        Balanced["BALANCED: 16 segments"]
        High["HIGH: 32 segments"]
    end
```

| Mode | Segments | Triangles | Use Case |
|------|----------|-----------|----------|
| FAST | 8 | Fewer | Mobile, preview |
| BALANCED | 16 | Medium | Default |
| HIGH | 32 | More | Detailed viewing |

## Instancing

### MappedItem Processing

```mermaid
flowchart TB
    subgraph Definition["Mapped Representation"]
        Source["Source Geometry"]
        Transform["Transform Matrix"]
    end

    subgraph Detection["Instance Detection"]
        Hash["Hash source ID"]
        Lookup["Lookup in cache"]
    end

    subgraph Output["Output"]
        Reuse["Reuse existing mesh"]
        Transforms["Instance transforms[]"]
    end

    Definition --> Detection
    Detection -->|"Cache hit"| Reuse
    Detection -->|"Cache miss"| Source
    Source --> Reuse
    Reuse --> Transforms
```

### Instance Data Structure

```typescript
interface InstancedMesh {
  baseMesh: Mesh;
  transforms: Matrix4[];
  expressIds: number[];
}

// GPU instancing data
interface InstanceData {
  positions: Float32Array;    // Shared geometry
  normals: Float32Array;
  indices: Uint32Array;
  instanceMatrices: Float32Array;  // Per-instance transforms
  instanceColors: Float32Array;    // Per-instance colors
}
```

## Streaming Pipeline

```mermaid
sequenceDiagram
    participant Parser
    participant Queue as Entity Queue
    participant Router
    participant Processor
    participant Collector as Mesh Collector
    participant GPU

    Parser->>Queue: Entities with geometry
    loop Batch Processing
        Queue->>Router: Entity batch
        Router->>Processor: Dispatch by type
        Processor->>Processor: Triangulate
        Processor->>Collector: Mesh batch
        Collector->>GPU: Upload buffers
    end
```

### Batch Processing

```typescript
async function processGeometryBatches(
  entities: Entity[],
  batchSize: number,
  onBatch: (batch: MeshBatch) => Promise<void>
): Promise<void> {
  const geoEntities = entities.filter(e => e.hasGeometry);

  for (let i = 0; i < geoEntities.length; i += batchSize) {
    const batch = geoEntities.slice(i, i + batchSize);
    const meshes = await Promise.all(
      batch.map(e => processEntity(e))
    );

    await onBatch({
      meshes,
      bounds: computeBounds(meshes),
      progress: (i + batch.length) / geoEntities.length
    });
  }
}
```

## CSG Kernel

Two boolean / CSG kernels coexist behind a Cargo feature flag.

### Default (legacy BSP)

`rust/geometry/src/bsp_csg.rs` — a Rust port of csg.js (Evan Wallace,
MIT). Triangle-mesh BSP. Hard-caps at 24 polygons per operand
(`csg.rs:117`). On cap exceeded or kernel error, falls back to the
un-cut host mesh and emits a structured `BoolFailure` record (drainable
via `GeometryRouter::take_csg_failures`). This is the default for the
`wasm32-unknown-unknown` build target since the alternative (Manifold)
has unresolved upstream toolchain dependencies on that target.

### Optional (Manifold)

Behind `--features manifold-csg`. Uses [Manifold](https://github.com/elalish/manifold)
via the `manifold-csg` crate (Apache-2/MIT, native C++ kernel built
through cmake). No operand cap, manifold-by-construction output, real
solid-solid `IfcBooleanResult.{DIFFERENCE, UNION, INTERSECTION}`. A
vertex-weld pre-pass in `rust/geometry/src/manifold_kernel.rs`
collapses the polygon-soup mesh layout ifc-lite's extruded-solid
builder produces (24 verts per cube → 8) so Manifold accepts the
input.

`BoolFailure` records and `GeometryRouter::take_csg_failures` work
identically under both kernels. Sprint 2 acceptance gates assert
`total_failures == 0` on `AC20-FZK-Haus.ifc` and
`C20-Institute-Var-2.ifc` under `--features manifold-csg`; both pass.

### WASM status

`--features manifold-csg-wasm-uu` is **enabled** as of `wasm-cxx-shim`
v0.5.0 / `manifold-csg-sys` 3.5.100 (May 2026); the libc++ / musl-locale
issues that previously blocked the wasm build have been resolved
upstream. `rust/wasm-bindings/Cargo.toml` opts into the feature and
`scripts/vercel-install.sh` provisions the host toolchain.

Build prerequisites:

- LLVM 18+ with `clang++`, `wasm-ld`, and `llvm-ar` on PATH (or pointed
  to via `WASM_CXX_SHIM_LLVM_BIN_DIR`).
- libc++ headers at `<llvm-prefix>/include/c++/v1/`. Not bundled with
  the AL2023 `clang20` package; on Vercel we fetch the matching
  `libcxx-N.N.N.src.tar.xz` from the LLVM release page into
  `/vercel/cache/wasm-cxx/` so subsequent deploys reuse it.
- CMake 3.18+ for the `wasm-cxx-shim` FetchContent build of Manifold +
  Clipper2.

Local dev:

- macOS: `brew install llvm lld`. The shim's toolchain file
  auto-detects `/opt/homebrew/opt/llvm@N/bin`; no env vars required.
- Debian/Ubuntu: `apt install clang-20 lld-20 libc++-20-dev libc++abi-20-dev`.
- Other hosts: see the wasm-cxx-shim CMake toolchain probe ladder
  documented at `cmake/toolchain-wasm32.cmake` in the shim sources.

Runtime properties of the wasm-side Manifold:

- Single-threaded execution (TBB is gated off — wasm has no threading
  in the unknown-unknown target). Same correctness as native, lower
  throughput on multi-core inputs.
- No exception runtime; the shim aborts on throw rather than unwinds.
  Malformed input that would have thrown native becomes a wasm
  `unreachable` trap. In practice this is the same surface area the
  pre-Manifold BSP path used to panic on, just with a cleaner
  diagnostic.
- Wasm bundle size impact: +250–400 KB (Manifold + Clipper2 + shim
  glue, after `wasm-opt`).

The legacy in-tree BSP port (`bsp_csg.rs`) is kept as a compile-time
fallback under `default-features = false` for downstream consumers who
need to build the geometry crate without LLVM available. There is no
runtime selection — the active kernel is decided at build time by the
feature set.

## Performance Metrics

| Operation | Time (typical) | Notes |
|-----------|---------------|-------|
| Profile extraction | 0.1 ms | Per entity |
| Earcut triangulation | 0.5 ms | Simple profile |
| Extrusion | 0.2 ms | Per entity |
| Boolean operation | 5-50 ms | Complex |
| Transform application | 0.01 ms | Per vertex |

### Throughput

- **Simple extrusions**: ~2000 entities/sec
- **Complex Breps**: ~200 entities/sec
- **Boolean operations**: ~20 entities/sec

## Next Steps

- [Rendering Pipeline](rendering-pipeline.md) - WebGPU rendering
- [API Reference](../api/rust.md) - Geometry API
