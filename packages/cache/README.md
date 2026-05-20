# @ifc-lite/cache

Binary cache format for IFClite. Caches parsed geometry as compressed GLB so a previously-loaded IFC reopens in milliseconds instead of re-running the full parse + tessellation pipeline. Content-addressable (SHA-256 of the source IFC), so cache invalidation is automatic.

## Installation

```bash
npm install @ifc-lite/cache
```

## Skip the parse on warm load

```typescript
import {
  computeFileHash,
  BinaryCacheReader,
  BinaryCacheWriter,
  loadGLBToMeshData,
} from '@ifc-lite/cache';

const ifcBuffer = await file.arrayBuffer();
const cacheKey = await computeFileHash(ifcBuffer);

// Try cache first
const cached = await myStorage.get(cacheKey); // your IndexedDB / fs / S3 lookup
if (cached) {
  const reader = new BinaryCacheReader(cached);
  const meshes = await loadGLBToMeshData(reader.readGeometry());
  renderer.loadGeometry(meshes);
  return; // first triangles in milliseconds
}

// Cold path — full parse, then write the cache
const meshes = await geometryProcessor.process(new Uint8Array(ifcBuffer));

const writer = new BinaryCacheWriter();
writer.writeGeometry({ meshes });
await myStorage.put(cacheKey, writer.toBuffer());
```

## Pure GLB read

If you already have a GLB blob (from a server, S3, etc.), skip the binary cache wrapper and load directly:

```typescript
import { loadGLBToMeshData, parseGLB } from '@ifc-lite/cache';

const meshes = await loadGLBToMeshData(glbBuffer);
// → MeshData[] ready to feed into @ifc-lite/renderer

// Or get the parsed GLB structure if you need lower-level access
const { json, bin, mapping } = parseGLB(glbBuffer);
```

## Hashing utilities

Two hash functions are exposed for cache key generation:

```typescript
import { xxhash64Hex, computeFileHash } from '@ifc-lite/cache';

const fastKey = xxhash64Hex(buffer);          // ~5 GB/s, 16-char hex — best for ephemeral keys
const stableKey = await computeFileHash(buf); // SHA-256 — persistent across machines
```

Use SHA-256 (the default) for any cache that survives a process restart. Use xxhash for purely in-memory deduplication.

## API

See the [API Reference](https://ltplus-ag.github.io/ifc-lite/api/typescript/#ifc-litecache).

## License

[MPL-2.0](../../LICENSE)
