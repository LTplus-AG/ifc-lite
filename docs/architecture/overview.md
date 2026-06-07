# Architecture Overview

This document describes the high-level architecture of IFClite, including both client-side and server-side processing paradigms.

## System Architecture

IFClite supports two processing paradigms: **client-side** (WASM in browser) and **server-side** (native Rust). It provides **multi-model federation** for loading and managing multiple IFC models simultaneously with unified selection, visibility control, and coordinated ID spaces.

### Layer Overview

```mermaid
flowchart TB
    subgraph Clients["Clients"]
        direction LR
        Web["Web App"]
        Desktop["Desktop (3rd-party Tauri)"]
        CLI["CLI"]
    end

    subgraph Features["Feature Layers"]
        direction LR
        Federation["Multi-Model Federation"]
        BCFFeature["BCF"]
        IDSFeature["IDS"]
        Drawings["2D Drawings"]
        MutationsFeature["Mutations"]
    end

    subgraph APIs["APIs"]
        direction LR
        TS["TypeScript"]
        WASM["WASM"]
        Rust["Rust"]
    end

    subgraph Storage["Storage"]
        direction LR
        Tables["Columnar Tables"]
        Graph["Relationship Graph"]
        GPU["GPU Buffers"]
    end

    Clients --> Features
    Features --> APIs
    APIs --> Storage
```

### Processing Paradigms

The system offers two processing paths depending on your needs:

```mermaid
flowchart LR
    subgraph ClientPath["Client-Side (WASM)"]
        direction TB
        C1["Parser"]
        C2["Geometry"]
        C3["Renderer"]
        C1 --> C2 --> C3
    end

    subgraph ServerPath["Server-Side (Native)"]
        direction TB
        S1["Parser"]
        S2["Geometry"]
        S3["Parquet Encoder"]
        S4["Content Cache"]
        S1 --> S2 --> S3 --> S4
    end
```

## Client vs Server Paradigm

| Aspect | Client-Side (WASM) | Server-Side (Rust) |
|--------|-------------------|-------------------|
| **Processing** | Single-threaded | Multi-threaded (Rayon) |
| **Memory** | 4GB WASM limit | System RAM |
| **Caching** | Browser storage | Content-addressable disk |
| **Format** | Raw geometry | Parquet (15-50x smaller) |
| **Best For** | Privacy, offline | Teams, large files |

## Design Principles

### 1. Zero-Copy Where Possible

Data flows through the system with minimal copying:

```mermaid
flowchart LR
    subgraph Traditional["Traditional Approach"]
        T1["File Buffer"]
        T2["Parse to Objects"]
        T3["Convert to Arrays"]
        T4["Upload to GPU"]
        T1 -->|copy| T2 -->|copy| T3 -->|copy| T4
    end

    subgraph IFCLite["IFClite Approach"]
        I1["File Buffer"]
        I2["Direct Index"]
        I3["TypedArrays"]
        I4["GPU Upload"]
        I1 -->|reference| I2 -->|view| I3 -->|share| I4
    end

    style Traditional fill:#dc2626,stroke:#7f1d1d,color:#fff
    style IFCLite fill:#16a34a,stroke:#14532d,color:#fff
```

### 2. Streaming First

Process data incrementally for responsive UIs:

```mermaid
sequenceDiagram
    participant File
    participant Parser
    participant Processor
    participant Renderer
    participant User

    File->>Parser: Chunk 1
    Parser->>Processor: Entities 1-100
    Processor->>Renderer: Meshes 1-50
    Renderer->>User: First render (300ms)

    File->>Parser: Chunk 2
    Parser->>Processor: Entities 101-200
    Processor->>Renderer: Meshes 51-100
    Note over User: Progressive loading

    File->>Parser: Chunk N
    Parser->>Processor: All entities
    Processor->>Renderer: All meshes
    Renderer->>User: Complete
```

### 3. On-Demand Property Extraction

Properties parsed lazily for faster initial load:

```mermaid
flowchart LR
    subgraph TraditionalParsing["Traditional"]
        T1["Parse All Entities"]
        T2["Parse All Properties"]
        T3["Build All Tables"]
        T1 --> T2 --> T3
    end

    subgraph OnDemand["IFClite On-Demand"]
        O1["Parse Entities"]
        O2["Build Index"]
        O3["Map: entityId → psetIds"]
        O4["Parse on Access"]
        O1 --> O2 --> O3
        O3 -.->|"lazy"| O4
    end

    style TraditionalParsing fill:#dc2626,stroke:#7f1d1d,color:#fff
    style OnDemand fill:#16a34a,stroke:#14532d,color:#fff
```

### 4. Columnar Storage

Store data in columnar format for cache-efficient access:

```mermaid
graph TB
    subgraph RowBased["Row-Based (Traditional)"]
        R1["Entity 1: id=1, type=WALL, name='A'"]
        R2["Entity 2: id=2, type=DOOR, name='B'"]
        R3["Entity 3: id=3, type=WALL, name='C'"]
    end

    subgraph Columnar["Columnar (IFClite)"]
        C1["IDs: Uint32Array [1, 2, 3, ...]"]
        C2["Types: Uint16Array [WALL, DOOR, WALL, ...]"]
        C3["Names: StringTable ['A', 'B', 'C', ...]"]
    end
```

### 5. Hybrid Data Model

Combine the best of different data structures:

| Data Structure | Use Case | Access Pattern |
|----------------|----------|----------------|
| Columnar Tables | Bulk queries, filtering | Sequential scan |
| CSR Graph | Relationship traversal | Adjacency lookup |
| On-Demand Maps | Property access | Hash lookup |
| BVH | Raycasting | Tree traversal |

## Package Architecture

The monorepo contains 18 TypeScript packages, 4 Rust crates, and multiple application targets.

```mermaid
graph TB
    subgraph Rust["Rust Crates"]
        Core["ifc-lite-core<br/>Parsing"]
        Geo["ifc-lite-geometry<br/>Triangulation"]
        Wasm["ifc-lite-wasm<br/>Bindings"]
        Server["ifc-lite-server<br/>HTTP API"]
    end

    subgraph TS["TypeScript Packages (18)"]
        Parser["@ifc-lite/parser"]
        IFCX["@ifc-lite/ifcx"]
        Geometry["@ifc-lite/geometry"]
        Renderer["@ifc-lite/renderer"]
        ServerClient["@ifc-lite/server-client"]
        ServerBin["@ifc-lite/server-bin"]
        Cache["@ifc-lite/cache"]
        Query["@ifc-lite/query"]
        Data["@ifc-lite/data"]
        Export["@ifc-lite/export"]
        BCF["@ifc-lite/bcf"]
        IDS["@ifc-lite/ids"]
        Drawing2D["@ifc-lite/drawing-2d"]
        Mutations["@ifc-lite/mutations"]
        Spatial["@ifc-lite/spatial"]
        Codegen["@ifc-lite/codegen"]
        WasmTS["@ifc-lite/wasm"]
        CreateCLI["@ifc-lite/create-ifc-lite"]
    end

    subgraph Apps["Applications"]
        Viewer["Viewer App"]
        Desktop["Desktop (3rd-party Tauri)"]
        CLI["create-ifc-lite"]
    end

    Wasm --> Core
    Wasm --> Geo
    Parser --> WasmTS
    WasmTS --> Wasm
    Geometry --> WasmTS
    Renderer --> Geometry
    ServerClient --> Server
    Query --> Data
    Export --> Data
    BCF --> Data
    IDS --> Data
    Drawing2D --> Geometry
    Mutations --> Data
    Spatial --> Data
    Viewer --> Parser
    Viewer --> Renderer
    Viewer --> ServerClient
    Desktop --> Core
    Desktop --> Geo
```

## Server Architecture

```mermaid
flowchart TB
    subgraph Client["Browser Client"]
        Hash["SHA-256 Hash"]
        Upload["File Upload"]
        Decode["Parquet Decoder"]
        Render["WebGPU Renderer"]
    end

    subgraph Server["Rust Server (Axum)"]
        Router["API Router"]
        Parser["IFC Parser"]
        GeoProc["Geometry Processor"]
        DataModel["Data Model Extractor"]
        Serializer["Parquet Serializer"]
    end

    subgraph Cache["Cache Layer"]
        DiskCache[(Disk Cache)]
    end

    Hash -->|"check"| Router
    Router -->|"hit"| DiskCache
    DiskCache --> Decode
    Upload -->|"miss"| Parser
    Parser --> GeoProc
    Parser --> DataModel
    GeoProc --> Serializer
    DataModel --> Serializer
    Serializer --> DiskCache
    Serializer --> Decode
    Decode --> Render

    style Client fill:#6366f1,stroke:#312e81,color:#fff
    style Server fill:#10b981,stroke:#064e3b,color:#fff
    style Cache fill:#f59e0b,stroke:#7c2d12,color:#fff
```

### Server Cache Strategy

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Cache

    Client->>Client: Compute SHA-256 hash
    Client->>Server: GET /cache/check/{hash}

    alt Cache Hit
        Server->>Cache: Lookup
        Cache-->>Server: Parquet data
        Server-->>Client: 200 (skip upload!)
    else Cache Miss
        Server-->>Client: 404
        Client->>Server: POST /parse/parquet
        Server->>Server: Parse (parallel)
        Server->>Cache: Store
        Server-->>Client: Parquet response
    end
```

## Data Flow

### Client-Side Parse Flow

Each model is parsed independently and then registered with the **FederationRegistry**, which assigns non-overlapping ID ranges (`idOffset`) so that multiple models can coexist with unique global IDs (`globalId = localExpressId + model.idOffset`).

```mermaid
flowchart TB
    Input["IFC File<br/>(ArrayBuffer)"]

    subgraph Tokenize["1. Tokenize"]
        STEP["STEP Lexer"]
        Tokens["Token Stream"]
    end

    subgraph Scan["2. Scan"]
        EntityScan["Entity Scanner"]
        Index["Entity Index"]
    end

    subgraph Decode["3. Decode"]
        Decoder["Entity Decoder"]
        Attrs["Attributes"]
    end

    subgraph Store["4. Store"]
        Tables["Columnar Tables"]
        Graph["Relationship Graph"]
        OnDemand["On-Demand Maps"]
    end

    subgraph Federate["5. Federate"]
        Registry["FederationRegistry"]
        GlobalIDs["Global ID Assignment"]
    end

    Output["IfcDataStore"]

    Input --> Tokenize
    Tokenize --> Scan
    Scan --> Decode
    Decode --> Store
    Store --> Federate
    Federate --> Output

    style Input fill:#6366f1,stroke:#312e81,color:#fff
    style Tokenize fill:#2563eb,stroke:#1e3a8a,color:#fff
    style Scan fill:#10b981,stroke:#064e3b,color:#fff
    style Decode fill:#f59e0b,stroke:#7c2d12,color:#fff
    style Store fill:#a855f7,stroke:#581c87,color:#fff
    style Federate fill:#ec4899,stroke:#831843,color:#fff
    style Output fill:#16a34a,stroke:#14532d,color:#fff
```

### Server-Side Parse Flow

```mermaid
flowchart TB
    Input["IFC File"]

    subgraph Parse["1. Parse (Parallel)"]
        Tokenize["STEP Tokenizer"]
        Extract["Entity Extractor"]
    end

    subgraph Process["2. Process (Parallel)"]
        Geo["Geometry Extraction"]
        Data["Data Model Extraction"]
    end

    subgraph Serialize["3. Serialize"]
        ParquetGeo["Parquet Geometry"]
        ParquetData["Parquet Data Model"]
    end

    subgraph Cache["4. Cache"]
        Store["Disk Cache"]
    end

    Output["Parquet Response"]

    Input --> Parse
    Parse --> Process
    Geo --> ParquetGeo
    Data --> ParquetData
    ParquetGeo --> Store
    ParquetData --> Store
    Store --> Output

    style Input fill:#6366f1,stroke:#312e81,color:#fff
    style Parse fill:#2563eb,stroke:#1e3a8a,color:#fff
    style Process fill:#10b981,stroke:#064e3b,color:#fff
    style Serialize fill:#f59e0b,stroke:#7c2d12,color:#fff
    style Cache fill:#a855f7,stroke:#581c87,color:#fff
```

### Render Flow

```mermaid
flowchart TB
    subgraph Input["Input"]
        Meshes["Mesh Data"]
        Camera["Camera State"]
    end

    subgraph Process["Processing"]
        Cull["Frustum Culling"]
        Sort["Depth Sort"]
        Batch["Batching"]
    end

    subgraph Upload["GPU Upload"]
        Vertex["Vertex Buffers"]
        Index["Index Buffers"]
        Uniform["Uniforms"]
    end

    subgraph Render["Render"]
        Pass["Render Pass"]
        Section["Section Planes"]
        Draw["Draw Calls"]
    end

    Output["Canvas"]

    Input --> Process
    Process --> Upload
    Upload --> Render
    Render --> Output

    style Input fill:#6366f1,stroke:#312e81,color:#fff
    style Process fill:#2563eb,stroke:#1e3a8a,color:#fff
    style Upload fill:#10b981,stroke:#064e3b,color:#fff
    style Render fill:#f59e0b,stroke:#7c2d12,color:#fff
    style Output fill:#a855f7,stroke:#581c87,color:#fff
```

## Memory Architecture

In a multi-model federation scenario, each loaded model maintains its own data store in the JS heap. The **FederationRegistry** tracks ID ranges per model to enable O(1) global-to-local ID resolution without duplicating entity data across models.

```mermaid
graph TB
    subgraph JS["JavaScript Heap"]
        Strings["String Table"]
        Metadata["Entity Metadata"]
        Query["Query Results"]
        OnDemand["On-Demand Maps"]
        FedRegistry["FederationRegistry"]
        Models["Models Map"]
    end

    subgraph Wasm["WASM Linear Memory"]
        Parser["Parser State"]
        Geometry["Geometry Processing"]
        Buffers["Mesh Buffers"]
    end

    subgraph GPU["GPU Memory"]
        VBO["Vertex Buffers"]
        IBO["Index Buffers"]
        UBO["Uniform Buffers"]
        ID["ID Buffer (Picking)"]
    end

    Wasm -->|"Zero-copy view"| JS
    Wasm -->|"Direct upload"| GPU
```

### Memory Efficiency

| Component | Memory Strategy |
|-----------|-----------------|
| Strings | Deduplicated string table (30% reduction) |
| Entity IDs | Uint32Array (fixed-size) |
| Types | Uint16Array enum (2 bytes vs ~20 for string) |
| Properties | On-demand parsing (not pre-loaded) |
| Geometry | Streaming + dispose after upload |
| Server | Parquet (15-50x smaller transfer) |

## Threading Model

### Client-Side

```mermaid
flowchart LR
    subgraph Main["Main Thread"]
        UI["UI Events"]
        Render["Rendering"]
        Query["Queries"]
    end

    subgraph Worker["Web Worker"]
        Parse["Parsing"]
        Geo["Geometry"]
    end

    Main <-->|"Transferable"| Worker
```

### Server-Side

```mermaid
flowchart TB
    subgraph Axum["Axum Runtime"]
        Router["Async Router"]
        Handlers["Request Handlers"]
    end

    subgraph Rayon["Rayon Thread Pool"]
        Parser1["Parser Thread 1"]
        Parser2["Parser Thread 2"]
        ParserN["Parser Thread N"]
    end

    subgraph Tokio["Tokio Runtime"]
        Cache["Cache I/O"]
        Response["Response Stream"]
    end

    Router --> Handlers
    Handlers -->|"spawn_blocking"| Rayon
    Handlers --> Tokio
```

## IFC5 (IFCX) Architecture

```mermaid
flowchart TB
    subgraph Input["IFCX File"]
        JSON["JSON Structure"]
        Header["Header"]
        Schemas["Schemas"]
        Data["Data Nodes"]
    end

    subgraph Composition["ECS Composition"]
        Flatten["Flatten Layers"]
        Inherit["Resolve Inheritance"]
        Tree["Build Tree"]
    end

    subgraph Extract["Extraction"]
        Entities["Entity Extractor"]
        Props["Property Extractor"]
        Geo["Geometry Extractor"]
        Hierarchy["Hierarchy Builder"]
    end

    subgraph Output["Output"]
        Store["IfcxParseResult"]
        Meshes["Pre-tessellated Meshes"]
    end

    Input --> Composition
    Composition --> Extract
    Extract --> Output

    style Input fill:#6366f1,stroke:#312e81,color:#fff
    style Composition fill:#10b981,stroke:#064e3b,color:#fff
    style Extract fill:#f59e0b,stroke:#7c2d12,color:#fff
    style Output fill:#a855f7,stroke:#581c87,color:#fff
```

## Extension Points

```mermaid
graph TB
    subgraph Core["Core System"]
        Parser["Parser"]
        Geometry["Geometry"]
        Renderer["Renderer"]
    end

    subgraph Extensions["Extension Points"]
        CustomExtractor["Custom Extractors"]
        CustomProcessor["Custom Processors"]
        CustomShaders["Custom Shaders"]
        Plugins["Plugins"]
    end

    CustomExtractor -.->|extends| Parser
    CustomProcessor -.->|extends| Geometry
    CustomShaders -.->|extends| Renderer
    Plugins -.->|hooks| Core
```

### Adding Custom Geometry Processor

```typescript
import { GeometryProcessor, ProcessorRegistry } from '@ifc-lite/geometry';

class CustomProcessor extends GeometryProcessor {
  canProcess(entity: Entity): boolean {
    return entity.type === 'IFCMYCUSTOMTYPE';
  }

  process(entity: Entity): Mesh {
    // Custom processing logic
    return mesh;
  }
}

ProcessorRegistry.register(new CustomProcessor());
```

## Technology Stack

```mermaid
graph TB
    subgraph Languages["Languages"]
        Rust["Rust"]
        TS["TypeScript"]
        WGSL["WGSL (Shaders)"]
    end

    subgraph Runtime["Runtime"]
        WASM["WebAssembly"]
        WebGPU["WebGPU"]
        Browser["Browser"]
        Node["Node.js"]
        Tauri["Tauri"]
    end

    subgraph Build["Build Tools"]
        Cargo["Cargo"]
        Vite["Vite"]
        WasmPack["wasm-pack"]
        Turborepo["Turborepo"]
    end

    subgraph Formats["Data Formats"]
        STEP["STEP (IFC4)"]
        IFCX["IFCX (IFC5)"]
        Parquet["Apache Parquet"]
        Cache["Binary Cache"]
    end

    Rust --> WASM
    Rust --> Tauri
    TS --> Browser
    TS --> Node
    WGSL --> WebGPU

    style Languages fill:#6366f1,stroke:#312e81,color:#fff
    style Runtime fill:#10b981,stroke:#064e3b,color:#fff
    style Build fill:#f59e0b,stroke:#7c2d12,color:#fff
    style Formats fill:#a855f7,stroke:#581c87,color:#fff
```

## Next Steps

- [Data Flow](data-flow.md) - Detailed data flow diagrams
- [Parsing Pipeline](parsing-pipeline.md) - Parser architecture
- [Geometry Pipeline](geometry-pipeline.md) - Geometry processing
- [Rendering Pipeline](rendering-pipeline.md) - WebGPU rendering
