# Data Flow

Detailed data flow through the IFClite system.

## Complete Data Flow

```mermaid
flowchart TB
    subgraph Input["Input"]
        File["IFC File"]
        URL["URL"]
        Buffer["ArrayBuffer"]
    end

    subgraph Parse["Parse Stage"]
        Scan["Scan Entities (memchr)"]
        Build["Build Entity Index"]
        Decode["Decode Attributes (lazy)"]
    end

    subgraph Store["Storage Stage"]
        Entities["Entity Table"]
        Properties["Property Table"]
        Quantities["Quantity Table"]
        Relations["Relationship Graph"]
    end

    subgraph Geometry["Geometry Stage"]
        Extract["Extract Geometry"]
        Triangulate["Triangulate"]
        Transform["Transform"]
        Buffer2["Build Buffers"]
    end

    subgraph Render["Render Stage"]
        Upload["GPU Upload"]
        Cull["Frustum Cull"]
        Draw["Draw"]
        Display["Display"]
    end

    Input --> Parse
    Parse --> Store
    Store --> Geometry
    Geometry --> Render

    style Input fill:#6366f1,stroke:#312e81,color:#fff
    style Parse fill:#2563eb,stroke:#1e3a8a,color:#fff
    style Store fill:#10b981,stroke:#064e3b,color:#fff
    style Geometry fill:#f59e0b,stroke:#7c2d12,color:#fff
    style Render fill:#a855f7,stroke:#581c87,color:#fff
```

## Parsing Data Flow

### Token Flow

Tokenization happens lazily, per entity, when attributes are decoded (the scan itself never builds tokens):

```mermaid
flowchart LR
    subgraph Input["Input"]
        Bytes["Entity byte span"]
    end

    subgraph Lexer["nom Tokenizer"]
        WS["Skip Whitespace"]
        Match["Match Token"]
        Emit["Emit Token"]
    end

    subgraph Tokens["Token Types"]
        EntityRef["EntityRef #123"]
        String["String (borrowed bytes)"]
        Number["Integer / Float"]
        Enum["Enum .T./.F./..."]
        List["List / TypedValue"]
    end

    Bytes --> WS --> Match --> Emit --> Tokens
```

### Entity Parsing

```mermaid
sequenceDiagram
    participant Input as Input Buffer
    participant Scanner as Entity Scanner
    participant Index as Entity Index
    participant Decoder as Attribute Decoder

    Input->>Scanner: Scan for #123=
    Scanner->>Scanner: Extract type name
    Scanner->>Index: Store (id, offset, type)

    Note over Index: Lazy storage

    Index->>Decoder: Request entity #123
    Decoder->>Input: Read from offset
    Decoder->>Decoder: Parse attributes
    Decoder-->>Index: Return decoded entity
```

### Memory Layout

```mermaid
graph TB
    subgraph File["File Buffer (ArrayBuffer)"]
        Header["HEADER Section"]
        Data["DATA Section"]
        End["END-ISO..."]
    end

    subgraph Index["Entity Index"]
        I1["#1 → offset 1234, IFCPROJECT"]
        I2["#2 → offset 2345, IFCSITE"]
        I3["#3 → offset 3456, IFCWALL"]
    end

    Data --> I1
    Data --> I2
    Data --> I3
```

## Storage Data Flow

### Columnar Tables

```mermaid
flowchart LR
    subgraph Decoded["Decoded Entities"]
        E1["Entity 1"]
        E2["Entity 2"]
        E3["Entity 3"]
    end

    subgraph Columns["Columnar Storage"]
        IDs["expressIds: Uint32Array<br/>[1, 2, 3, ...]"]
        Types["typeEnums: Uint16Array<br/>[5, 12, 8, ...]"]
        Names["nameIndices: Uint32Array<br/>[42, 0, 15, ...]"]
        Flags["flags: Uint8Array<br/>[3, 1, 3, ...]"]
    end

    subgraph Strings["String Table"]
        S1["'Project Name'"]
        S2["'Wall-001'"]
        S3["..."]
    end

    E1 --> IDs
    E2 --> IDs
    E3 --> IDs
    Names --> Strings
```

### Relationship Graph

```mermaid
graph LR
    subgraph CSR["CSR Format"]
        Offsets["offsets: [0, 2, 5, 7, ...]"]
        Edges["edges: [2, 3, 4, 5, 6, 7, 8, ...]"]
        Types["types: [1, 1, 2, 2, 2, 3, 3, ...]"]
    end

    subgraph Query["Query: Get children of #1"]
        Start["offsets[1] = 0"]
        End["offsets[2] = 2"]
        Children["edges[0..2] = [2, 3]"]
    end

    Offsets --> Start
    Offsets --> End
    Edges --> Children
```

## Geometry Data Flow

### Processing Pipeline

```mermaid
flowchart TB
    subgraph Extract["1. Extract"]
        Entity["IFC Entity"]
        Shape["Shape Representation"]
        Placement["Local Placement"]
    end

    subgraph Route["2. Route"]
        Router["GeometryRouter"]
        ExtProc["Extrusion / Swept"]
        BrepProc["Brep / AdvancedBrep"]
        BoolProc["Boolean (exact CSG)"]
        TessProc["Tessellated / Surface"]
        MapProc["MappedItem (instancing)"]
    end

    subgraph Triangulate["3. Triangulate"]
        Profile["Profile → 2D Points"]
        Earcut["Earcut Triangulation"]
        Normals["Compute Normals"]
    end

    subgraph Output["4. Output"]
        Positions["Float32Array positions<br/>(relative to per-element origin)"]
        NormalsOut["Float32Array normals"]
        Indices["Uint32Array indices"]
        Origin["origin: [f64; 3]"]
    end

    Extract --> Route
    Route --> Triangulate
    Triangulate --> Output
```

### Coordinate Transformation

```mermaid
flowchart LR
    subgraph Local["Local Coordinates"]
        LP["Profile Points<br/>(2D, f64)"]
    end

    subgraph Transform["Transformations (f64)"]
        Extrude["Extrude to 3D"]
        Place["Apply Placement"]
        RTC["Subtract RTC offset<br/>(large-coordinate models)"]
        Frame["Split into per-element<br/>origin + local positions"]
    end

    subgraph GPU["GPU Coordinates"]
        WP["Local Points (f32)<br/>+ origin [f64; 3]"]
    end

    LP --> Extrude --> Place --> RTC --> Frame --> WP
```

All placement math runs in f64 on the CPU; only the final per-element local positions are stored as f32, with the world-magnitude translation kept in the f64 `origin`. See [Coordinate Handling](coordinate-handling.md).

## Render Data Flow

### Buffer Upload

```mermaid
flowchart TB
    subgraph CPU["CPU Memory"]
        Mesh["Mesh Data"]
        Positions["positions: Float32Array"]
        Normals["normals: Float32Array"]
        Indices["indices: Uint32Array"]
    end

    subgraph Transfer["Transfer"]
        Interleave["Interleave<br/>(pos + normal + entityId)"]
        Write["queue.writeBuffer"]
    end

    subgraph GPU["GPU Memory"]
        VBO["Vertex Buffer"]
        IBO["Index Buffer"]
        UBO["Uniform Buffer"]
    end

    CPU --> Transfer --> GPU
```

### Render Pass

```mermaid
flowchart TB
    subgraph Setup["Setup"]
        Pass["Begin Render Pass"]
        Pipeline["Set Pipeline"]
        Bind["Bind Groups"]
    end

    subgraph Draw["Draw Loop"]
        ForEach["For Each Batch / Instanced Shard"]
        Cull["Frustum Cull (AABB)"]
        SetBuffers["Set Buffers"]
        DrawCall["Draw Indexed (+ instanced)"]
    end

    subgraph Finish["Finish"]
        End["End Pass"]
        Submit["Submit Commands"]
        Present["Present Frame"]
    end

    Setup --> Draw --> Finish
```

### Frame Timeline

```mermaid
gantt
    title Frame Timeline (16.67ms @ 60fps)
    dateFormat X
    axisFormat %L ms

    section CPU
    Update Camera    :a1, 0, 1
    Frustum Cull     :a2, 1, 2
    Update Uniforms  :a3, 2, 3
    Build Commands   :a4, 3, 5

    section GPU
    Vertex Shader    :b1, 5, 8
    Rasterization    :b2, 8, 12
    Fragment Shader  :b3, 12, 15
    Present          :b4, 15, 17
```

## Query Data Flow

### Fluent Query

```mermaid
flowchart LR
    subgraph Build["Build Query"]
        Start["query"]
        Type[".walls()"]
        Filter[".whereProperty()"]
        Select[".select()"]
    end

    subgraph Execute["Execute"]
        Plan["Query Plan"]
        Scan["Column Scan"]
        Filter2["Apply Filters"]
        Project["Project Fields"]
    end

    subgraph Result["Result"]
        Array["Entity[]"]
    end

    Build --> Execute --> Result
```

### SQL Query

```mermaid
flowchart TB
    subgraph Input["Input"]
        SQL["SQL Query String"]
    end

    subgraph DuckDB["DuckDB-WASM"]
        Parse["Parse SQL"]
        Optimize["Optimize Plan"]
        Execute["Execute"]
    end

    subgraph Data["Data Sources"]
        Entities["entities table"]
        Properties["properties table"]
        Quantities["quantities table"]
    end

    subgraph Output["Output"]
        Rows["Result Rows"]
    end

    SQL --> DuckDB
    Data --> DuckDB
    DuckDB --> Rows
```

## Export Data Flow

Exporters are implemented in Rust (`rust/export`: glTF/GLB, STEP/IFC, IFC5/IFCX, CSV, JSON, OBJ, KMZ, HBJSON, Parquet, and more) and surfaced through the WASM API and the CLI. The TypeScript `@ifc-lite/export` package hosts the browser-side orchestration (merged export, schema conversion, change sets).

### glTF Export

```mermaid
flowchart TB
    subgraph Input["Input"]
        ParseResult["ParseResult"]
        Meshes["Mesh Data"]
        Props["Properties"]
    end

    subgraph Convert["Conversion"]
        Nodes["Build Node Tree"]
        Buffers["Pack Buffers"]
        Materials["Export Materials"]
        Extras["Add Extras (props)"]
    end

    subgraph Output["Output"]
        JSON[".gltf JSON"]
        BIN[".bin Binary"]
        GLB[".glb (combined)"]
    end

    Input --> Convert
    Convert --> Output
```

## Data Size Estimates

| Stage | Data Size (50MB IFC) | Notes |
|-------|---------------------|-------|
| File Buffer | 50 MB | Original file |
| Entity Index | ~2 MB | Just offsets + types |
| Columnar Tables | ~5 MB | Deduped, compact |
| Relationship Graph | ~1 MB | CSR format |
| Geometry Buffers | ~20 MB | Triangulated meshes |
| GPU Buffers | ~20 MB | Mirrors CPU |

## Multi-Model Federation Data Flow

When multiple IFC files are loaded, each model is assigned a unique ID offset by the `FederationRegistry`:

```mermaid
flowchart TB
    subgraph Files["Input Files"]
        File1["Model A.ifc"]
        File2["Model B.ifc"]
    end

    subgraph Registry["FederationRegistry"]
        Reg1["Model A: offset=0, max=5000"]
        Reg2["Model B: offset=5000, max=3000"]
    end

    subgraph Store["Zustand Store"]
        Models["models Map<br/>FederatedModel[]"]
        Selection["selectionSlice<br/>EntityRef: modelId + expressId"]
        Visibility["visibilitySlice<br/>globalIds in hiddenEntities"]
    end

    Files --> Registry
    Registry --> Store

    Click["User Click"] --> GlobalId["globalId from GPU"]
    GlobalId --> Resolve["resolveGlobalIdFromModels"]
    Resolve --> EntityRef["{ modelId, expressId }"]
    EntityRef --> Selection
```

All mesh geometry uses **global IDs** (`expressId + offset`) for the GPU pick buffer, while the application logic uses **EntityRef** (`{ modelId, expressId }`) for unambiguous references.

## Mutation Data Flow

Property editing flows through the `MutablePropertyView` overlay:

```mermaid
flowchart LR
    subgraph Read["Read Path"]
        Query["Get Property"] --> Check["Check Overlay"]
        Check -->|Has Override| Overlay["Return Mutated Value"]
        Check -->|No Override| Original["Return Original Value"]
    end

    subgraph Write["Write Path"]
        Edit["Set Property"] --> Record["Record Mutation<br/>(old + new value)"]
        Record --> UpdateOverlay["Update Overlay Map"]
        Record --> UndoStack["Push to Undo Stack"]
    end

    subgraph Export["Export"]
        Changes["All Mutations"] --> ChangeSet["Change Set JSON"]
        Changes --> IFCExport["Modified IFC File"]
    end
```

## Next Steps

- [Parsing Pipeline](parsing-pipeline.md) - Parser details
- [Geometry Pipeline](geometry-pipeline.md) - Geometry details
- [Rendering Pipeline](rendering-pipeline.md) - Renderer details
- [Federation Architecture](federation.md) - Multi-model federation details
