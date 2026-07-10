# Server Guide

This guide covers the IFClite server architecture for production deployments with intelligent caching, parallel processing, and streaming.

## Overview

The IFClite server processes IFC files on a high-performance Rust backend, providing:

- **Content-Addressable Caching** - Same file = instant response (skip upload entirely)
- **Parallel Processing** - Multi-core geometry extraction with Rayon
- **Parquet Format** - roughly 15-50x smaller payloads than JSON
- **SSE Streaming** - Progressive geometry for immediate rendering
- **Full Data Model** - Properties, quantities, and spatial hierarchy computed upfront

!!! info "Client-Side WASM Is Now the Default"
    As of the latest release, **client-side WASM parsing is the default** processing mode. The server is no longer required for basic usage and must be explicitly opted into. Use the server when you need shared caching, parallel processing for very large files, or team-wide deployments.

## When to Use Server vs Client

| Scenario | Recommendation |
|----------|----------------|
| Single file, one-time view | Client-only (`@ifc-lite/parser`) |
| Team sharing same files | Server with caching |
| Large models (100+ MB) | Server with streaming |
| Repeat access to same files | Server with caching |
| Offline/embedded apps | Client-only |
| Privacy-sensitive data | Client-only |

## Architecture

```mermaid
flowchart TB
    subgraph Browser["Browser Client"]
        Upload[File Upload]
        Hash[SHA-256 Hash]
        Decode[Parquet Decoder]
        Render[WebGPU Renderer]
    end

    subgraph Server["Rust Server (Axum)"]
        Router[API Router]
        Parser[IFC Parser]
        Geometry[Geometry Processor]
        DataModel[Data Model Extractor]
        Parquet[Parquet Serializer]
    end

    subgraph Storage["Storage Layer"]
        Cache[(Disk Cache)]
    end

    Upload --> Hash
    Hash -->|check| Router
    Router -->|hit| Cache
    Cache -->|parquet| Decode
    Router -->|miss| Parser
    Parser --> Geometry
    Parser --> DataModel
    Geometry --> Parquet
    DataModel --> Parquet
    Parquet --> Cache
    Parquet --> Decode
    Decode --> Render

    style Browser fill:#6366f1,stroke:#312e81,color:#fff
    style Server fill:#10b981,stroke:#064e3b,color:#fff
    style Storage fill:#f59e0b,stroke:#7c2d12,color:#fff
```

## Quick Start

### 1. Start the Server

<!-- markdownlint-disable MD046 -->
=== "Docker (Recommended)"

    ```bash
    docker run -p 3001:8080 \
      -v ifc-cache:/app/cache \
      ghcr.io/ltplus-ag/ifc-lite-server
    ```

=== "Native Binary"

    ```bash
    npx @ifc-lite/server-bin
    ```

=== "From Source"

    ```bash
    cd apps/server
    cargo run --release
    ```
<!-- markdownlint-enable MD046 -->

### 2. Connect from Client

```typescript
import { IfcServerClient } from '@ifc-lite/server-client';

const client = new IfcServerClient({
  baseUrl: 'http://localhost:3001'
});

// Health check
const health = await client.health();
console.log('Server status:', health.status);
```

### 3. Parse a File

```typescript
// Parquet format (~15x smaller than JSON)
const result = await client.parseParquet(file);

console.log(`Meshes: ${result.meshes.length}`);
console.log(`Cache key: ${result.cache_key}`);
console.log(`From cache: ${result.stats.from_cache}`);
```

## API Endpoints

### Parse Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/parse` | POST | Full parse, JSON response |
| `/api/v1/parse/parquet` | POST | Full parse, Parquet response (~15x smaller) |
| `/api/v1/parse/parquet/optimized` | POST | Optimized Parquet (~50x smaller) |
| `/api/v1/parse/stream` | POST | Streaming JSON (SSE) |
| `/api/v1/parse/parquet-stream` | POST | Streaming Parquet (SSE) |
| `/api/v1/parse/metadata` | POST | Quick metadata only (no geometry) |

All parse endpoints that return geometry also surface the 2D symbol stream
(`IfcAnnotation` + `IfcGrid`), matching `@ifc-lite/parse`. The JSON and SSE
responses carry it inline as `symbolic_data` (in the `complete` event for the
streaming variants); the binary Parquet transports expose it by cache key via
`/api/v1/parse/symbolic/{key}` (see below).

Every geometry endpoint's `ModelMetadata` carries `length_unit_scale` (factor to
convert model length values to metres, e.g. `0.001` for millimetres) and, when
the model has an `IfcMapConversion` / `IfcProjectedCRS`, a `georeferencing`
object (CRS name, datum, false eastings/northings, orthogonal height, grid-north
rotation, and a local→map 4×4 matrix) — matching `@ifc-lite/parse`. For the
JSON/SSE endpoints it's on `metadata`; for the Parquet endpoints it's in the
`X-IFC-Metadata` header.

### Cache Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/cache/check/{hash}` | GET | Check if file is cached (200 or 404) |
| `/api/v1/cache/geometry/{hash}` | GET | Fetch cached geometry (no upload) |
| `/api/v1/cache/{key}` | GET | Retrieve cached JSON result |
| `/api/v1/parse/data-model/{key}` | GET | Fetch cached data model |
| `/api/v1/parse/symbolic/{key}` | GET | Fetch 2D symbol data (`IfcAnnotation` + `IfcGrid`) as JSON |

### Utility Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API information |
| `/api/v1/health` | GET | Health check (liveness; always open) |
| `/api/v1/ready` | GET | Readiness probe (503 while the memory breaker is shedding load) |
| `/api/v1/metrics` | GET | Prometheus text metrics (registered only when `IFC_METRICS_ENABLED=1`) |

!!! note "Optional bearer-token auth"
    When `IFC_SERVER_API_TOKEN` (or `API_TOKEN`) is set, all parse and cache
    endpoints require an `Authorization: Bearer <token>` header and return 401
    otherwise. The `/`, `/api/v1/health`, and `/api/v1/ready` probes stay open
    so health checks keep working. When unset (the default), all routes are
    open and the server logs a startup warning that it is unauthenticated.

## Client SDK

### IfcServerClient

```typescript
import { IfcServerClient } from '@ifc-lite/server-client';

const client = new IfcServerClient({
  baseUrl: 'http://localhost:3001',
  timeout: 300000  // 5 minutes (default)
});
```

### Parse Methods

#### parseParquet (Recommended)

Best for most use cases - roughly 15x smaller payloads than JSON.

```typescript
const result = await client.parseParquet(file);

// Result contains:
// - cache_key: string
// - meshes: MeshData[]
// - metadata: ModelMetadata
// - stats: ProcessingStats
// - parquet_stats: { payload_size, decode_time_ms }
// - data_model?: ArrayBuffer (properties, quantities, hierarchy)
```

#### parseParquetOptimized

Roughly 50x smaller payloads using integer quantization (0.1mm precision).

```typescript
const result = await client.parseParquetOptimized(file);

// Same as parseParquet but with:
// - Integer vertex quantization (0.1mm precision)
// - Byte colors (0-255 instead of 0-1)
// - Mesh deduplication (instancing)
```

#### parseParquetStream

Progressive rendering for large files (>50MB).

```typescript
import type { MeshData as ServerMeshData } from '@ifc-lite/server-client';

// Server meshes use snake_case fields (express_id); map them into the
// renderer's camelCase MeshData shape before uploading.
const toRendererMesh = (m: ServerMeshData) => ({
  expressId: m.express_id,
  ifcType: m.ifc_type,
  positions: m.positions,
  normals: m.normals,
  indices: m.indices,
  color: m.color,
});

const streamResult = await client.parseParquetStream(file, (batch) => {
  // Called for each geometry batch
  renderer.addMeshes(batch.meshes.map(toRendererMesh));
});

// Or use async iterator
for await (const event of client.parseStream(file)) {
  switch (event.type) {
    case 'start':
      console.log(`Processing ~${event.total_estimate} entities`);
      break;
    case 'batch':
      renderer.addMeshes(event.meshes.map(toRendererMesh));
      break;
    case 'progress':
      console.log(`${event.processed}/${event.total}`);
      break;
    case 'complete':
      console.log(`Done in ${event.stats.total_time_ms}ms`);
      break;
  }
}
```

#### getMetadata

Quick metadata extraction without geometry processing.

```typescript
const metadata = await client.getMetadata(file);

// Returns:
// - schema_version: string (e.g. 'IFC2X3', 'IFC4', 'IFC4X3')
// - entity_count: number
// - geometry_count: number
// - file_size: number
```

### Cache Methods

#### Checking Cache Before Upload

`parseParquet` hashes the file client-side and checks the server cache
before uploading, so re-parsing the same file skips the upload automatically:

```typescript
// Automatic: parseParquet computes the SHA-256 and does the cache check
// internally, returning the cached result without re-uploading on a hit.
const result = await client.parseParquet(file);
```

To retrieve a previously processed result later, keep its `cache_key`. Re-calling
`parseParquet` serves the geometry straight from the cache; fetch the cached data
model (properties + spatial hierarchy) with `fetchDataModel`:

```typescript
// Geometry: re-calling parseParquet returns the cached result without re-upload.
const result = await client.parseParquet(file);

// Data model (properties + hierarchy) for a known cache key:
const dataModelBuffer = await client.fetchDataModel(result.cache_key);
```

`getCached(key)` is the lower-level lookup for the JSON `parse()` cache and
returns a `ParseResponse`; it is not the retrieval path for Parquet geometry.

#### Fetching Data Model

Properties and spatial hierarchy are computed in parallel and cached:

```typescript
import { decodeDataModel } from '@ifc-lite/server-client';

const result = await client.parseParquet(file);

// Data model might still be processing
// Use polling to wait for it
const dataModel = await client.fetchDataModel(result.cache_key);

if (dataModel) {
  const decoded = await decodeDataModel(dataModel);
  console.log(`Entities: ${decoded.entities.size}`);
  console.log(`Property sets: ${decoded.propertySets.size}`);
}
```

#### Fetching Symbolic Data

The JSON (`parse`) and streaming endpoints return the 2D symbol stream
(`IfcAnnotation` + `IfcGrid`) inline as `symbolic_data`. The binary Parquet
endpoints (`parseParquet`, `parseParquetOptimized`) can't carry it inline —
fetch it by cache key instead:

```typescript
const result = await client.parseParquet(file);

const symbols = await client.fetchSymbolic(result.cache_key);
if (symbols) {
  console.log(`Grid axes: ${symbols.grid_axes.length}`);
  console.log(`Annotations: ${symbols.polylines.length} polylines, ${symbols.texts.length} labels`);
}
```

### Utility Methods

```typescript
// Health check
const health = await client.health();

// Uploads are gzip-compressed automatically by parse()/parseParquet(),
// so no manual compression step is needed.

// Check Parquet decoder availability
const available = await client.isParquetSupported();
```

## Data Model

The server computes a complete data model including entities, property sets,
quantity sets, relationships, spatial hierarchy, and — matching `@ifc-lite/parse`
— per-element **classifications** (`IfcClassificationReference`), **materials**
(`IfcMaterialLayerSet` layers with metre thicknesses), and **documents**
(`IfcDocumentReference`). The latter three are exposed as flat, element-keyed
arrays on the decoded `DataModel` (`classifications`, `materials`, `documents`)
and decode to empty arrays when served by an older server/cache.

### Entities

```typescript
interface EntityMetadata {
  entity_id: number;
  type_name: string;
  global_id?: string;
  name?: string;
  description?: string;
  object_type?: string;
  has_geometry: boolean;
}
```

### Properties

```typescript
interface PropertySet {
  pset_id: number;
  pset_name: string;
  properties: Property[];
}

interface Property {
  property_name: string;
  property_value: string;
  property_type: string;
}
```

### Quantities

```typescript
interface QuantitySet {
  qset_id: number;
  qset_name: string;
  method_of_measurement?: string;
  quantities: Quantity[];
}

interface Quantity {
  quantity_name: string;
  quantity_value: number;
  quantity_type: string;  // 'Area', 'Volume', 'Length', etc.
}
```

### Spatial Hierarchy

```typescript
interface SpatialHierarchy {
  nodes: SpatialNode[];
  project_id: number;
  element_to_storey: Map<number, number>;
  element_to_building: Map<number, number>;
  element_to_site: Map<number, number>;
  element_to_space: Map<number, number>;
}

interface SpatialNode {
  entity_id: number;
  parent_id: number;
  level: number;
  path: string;
  type_name: string;
  name?: string;
  elevation?: number;
  children_ids: number[];
  element_ids: number[];
}
```

## Parquet Format

The server uses Apache Parquet for efficient binary serialization.

### Standard Format

```text
[mesh_table][vertex_table][index_table]
```

- **Mesh Table**: express_id, ifc_type, vertex/index offsets, RGBA color
- **Vertex Table**: x, y, z (Float32), nx, ny, nz (Float32)
- **Index Table**: i0, i1, i2 (Uint32 triangle indices)

### Optimized Format

```text
[instance_table][mesh_table][material_table][vertex_table][index_table]
```

- **Instance Table**: entity_id, ifc_type, mesh_index, material_index
- **Mesh Table**: Deduplicated unique geometries
- **Material Table**: Deduplicated RGBA colors (Uint8)
- **Vertex Table**: Quantized integers (0.1mm precision)
- **Index Table**: Triangle indices

### Decoding on Client

```typescript
import {
  decodeParquetGeometry,
  decodeOptimizedParquetGeometry,
  decodeDataModel
} from '@ifc-lite/server-client';

// Standard Parquet
const meshes = await decodeParquetGeometry(parquetBuffer);

// Optimized Parquet (with vertex dequantization)
const optimizedMeshes = await decodeOptimizedParquetGeometry(parquetBuffer, 10000);

// Data model
const dataModel = await decodeDataModel(dataModelBuffer);
```

## Caching Strategy

### Content-Addressable Keys

Cache keys are derived from file content:

```
# {filter} is the opening filter (e.g. "default"); a non-default tessellation
# quality appends a "-q{level}" suffix after it
{SHA256}-{filter}-parquet-v4          # Geometry
{SHA256}-{filter}-parquet-metadata-v4 # Metadata header
{SHA256}-{filter}-datamodel-v2        # Properties & hierarchy
{SHA256}-{filter}-symbolic-v1         # 2D symbol stream
```

### Cache Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Cache

    Client->>Client: Compute SHA-256 hash
    Client->>Server: GET /cache/check/{hash}

    alt Cache Hit
        Server->>Cache: Lookup geometry
        Cache-->>Server: Parquet data
        Server-->>Client: 200 + geometry
        Note over Client: Skip upload entirely!
    else Cache Miss
        Server-->>Client: 404
        Client->>Server: POST /parse/parquet
        Server->>Server: Parse IFC
        Server->>Server: Extract geometry (parallel)
        Server->>Server: Extract data model (parallel)
        Server->>Cache: Store all results
        Server-->>Client: Parquet response
    end
```

### Cache Benefits

| Scenario | Without Cache | With Cache |
|----------|--------------|------------|
| First load of a file | Full parse + geometry extraction | Full parse + geometry extraction |
| Repeat load of the same file | Full parse again | **Serve pre-computed Parquet from disk** |
| Upload | Always | **Skipped entirely on a hit** (hash check first) |

On a cache hit the server does no parsing at all: the response is a disk read
plus network transfer, so repeat loads are typically orders of magnitude
faster than the first load.

## Server Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |
| `RUST_LOG` | info (+ debug for server/http spans) | Log filter (error, warn, info, debug, trace) |
| `MAX_FILE_SIZE_MB` | 500 | Maximum upload size in MB |
| `WORKER_THREADS` | CPU cores | Parallel processing threads |
| `CACHE_DIR` | `./.cache` (`/app/cache` in Docker) | Cache directory path |
| `REQUEST_TIMEOUT_SECS` | 300 | Request timeout in seconds |
| `INITIAL_BATCH_SIZE` | 100 | Streaming initial batch size |
| `MAX_BATCH_SIZE` | 1000 | Streaming maximum batch size |
| `CACHE_MAX_AGE_DAYS` | 7 | Cache retention in days |
| `CORS_ORIGINS` | localhost dev origins | Allowed CORS origins (comma-separated, `*` for all) |
| `IFC_SERVER_API_TOKEN` | unset | Optional bearer token for parse/cache routes (falls back to `API_TOKEN`) |
| `IFC_MAX_CONCURRENT_PARSES` | `WORKER_THREADS` | Parse jobs admitted at once (CPU gate) |
| `IFC_MEM_BUDGET_MB` | 70% of detected memory limit | Upload bytes admitted at once; `0` disables the memory gate |
| `IFC_ADMISSION_QUEUE_DEPTH` | 2 x `WORKER_THREADS` | Requests allowed to queue for an admission permit |
| `IFC_ADMISSION_QUEUE_TIMEOUT_SECS` | 5 | Longest a queued request waits for a permit |
| `IFC_MEM_SHED_PCT` | 85 | RSS percentage of the budget above which new parses are shed |
| `IFC_METRICS_ENABLED` | false | Expose `GET /api/v1/metrics` |

### Docker Compose

```yaml
version: '3.8'

services:
  ifc-lite-server:
    image: ghcr.io/ltplus-ag/ifc-lite-server:latest
    ports:
      - "3001:8080"
    environment:
      - RUST_LOG=info
      - MAX_FILE_SIZE_MB=500
      - WORKER_THREADS=8
      - CACHE_MAX_AGE_DAYS=30
    volumes:
      - ifc-cache:/app/cache

volumes:
  ifc-cache:
```

!!! tip "Adding Health Checks"
    For orchestration systems requiring health checks, the server exposes
    `GET /api/v1/health`. If your runtime image includes `curl` or `wget`:

    ```yaml
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:8080/api/v1/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
    ```

### Production Deployment

For production, consider:

1. **Reverse Proxy** - Use nginx or Traefik for SSL termination
2. **Persistent Cache** - Mount a volume for the cache directory
3. **Resource Limits** - Set memory/CPU limits based on expected file sizes
4. **Monitoring** - Enable debug logging for troubleshooting

```bash
# Railway deployment
railway up

# Fly.io deployment
fly deploy

# Kubernetes
kubectl apply -f k8s/deployment.yaml
```

## Streaming

### Dynamic Batch Sizing

The server uses dynamic batch sizing for optimal streaming:

- **Initial batch**: 100 entities (fast first frame)
- **Growth**: Increases based on processing speed
- **Maximum**: 1000 entities per batch

### Streaming Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Cache

    Client->>Server: POST /parse/parquet-stream
    Server->>Client: SSE: start {total_estimate, cache_key}

    loop For each batch
        Server->>Server: Process geometry batch
        Server->>Client: SSE: batch {data, mesh_count}
        Client->>Client: Decode & render
    end

    Server->>Cache: Store accumulated meshes
    Server->>Server: Extract data model (background)
    Server->>Cache: Store data model
    Server->>Client: SSE: complete {stats, metadata}
```

### Client-Side Streaming

```typescript
import type { MeshData as ServerMeshData } from '@ifc-lite/server-client';

// Server meshes use snake_case fields; map to the renderer's shape.
const toRendererMesh = (m: ServerMeshData) => ({
  expressId: m.express_id,
  ifcType: m.ifc_type,
  positions: m.positions,
  normals: m.normals,
  indices: m.indices,
  color: m.color,
});

// Using callback
await client.parseParquetStream(file, (batch) => {
  // batch.meshes are already decoded server MeshData
  renderer.addMeshes(batch.meshes.map(toRendererMesh));
});

// Using async iterator
for await (const event of client.parseStream(file)) {
  if (event.type === 'batch') {
    renderer.addMeshes(event.meshes.map(toRendererMesh));
  }
}
```

## Performance Optimization

### Server-Side

1. **Parallel Processing** - Geometry and data model extracted concurrently
2. **Rayon Thread Pool** - Utilizes all CPU cores
3. **Streaming Caching** - Meshes accumulated during stream, cached at end
4. **Lazy Data Model** - Client polls for data model while rendering geometry

### Client-Side

1. **Hash Check First** - Skip upload if file is cached
2. **Parquet Decoding** - WASM-based decoder for fast parsing
3. **Progressive Rendering** - Render batches as they arrive
4. **Background Polling** - Fetch data model while geometry renders

### Network

1. **Gzip Compression** - Applied automatically on upload by `parse()`/`parseParquet()`
2. **Parquet Format** - roughly 15-50x smaller than JSON
3. **SSE Streaming** - No polling overhead

## Error Handling

### Server Errors

```typescript
try {
  const result = await client.parseParquet(file);
} catch (error) {
  if (error.status === 413) {
    console.error('File too large - increase MAX_FILE_SIZE_MB');
  } else if (error.status === 408) {
    console.error('Timeout - try streaming for large files');
  } else if (error.status === 500) {
    console.error('Server error:', error.message);
  }
}
```

### Streaming Errors

```typescript
for await (const event of client.parseStream(file)) {
  if (event.type === 'error') {
    console.error('Stream error:', event.message);
    break;
  }
}
```

### Connection Errors

```typescript
try {
  await client.health();
} catch (error) {
  if (error.message.includes('ECONNREFUSED')) {
    console.error('Server not running');
  } else if (error.message.includes('timeout')) {
    console.error('Server not responding');
  }
}
```

## Next Steps

- [Parsing Guide](parsing.md) - Client-side parsing details
- [Rendering Guide](rendering.md) - WebGPU rendering features
- [API Reference](../api/typescript.md) - Complete API documentation
- [Architecture](../architecture/overview.md) - System design details
