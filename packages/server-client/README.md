# @ifc-lite/server-client

TypeScript SDK for the IFClite server. Handles content-addressable caching (skip the upload if the server already has it), streaming via SSE, and Parquet/Arrow response decoding.

## Installation

```bash
npm install @ifc-lite/server-client
```

## Parse with caching (one-shot)

```typescript
import { IfcServerClient } from '@ifc-lite/server-client';

const client = new IfcServerClient({ baseUrl: 'https://your-server.com' });

const result = await client.parseParquet(file);

// Hashes the file client-side first, sends only the hash. If the server
// has it cached, the upload is skipped entirely — second loads are instant.
console.log(`${result.metadata.entity_count} entities, ${result.meshes.length} meshes`);
```

## Stream a large file

```typescript
import type { MeshData as ServerMeshData } from '@ifc-lite/server-client';
import type { MeshData } from '@ifc-lite/geometry';

// Server meshes are the snake_case wire shape. Converting them is a real seam,
// not a rename: `origin` and `geometryClass` must be OMITTED rather than
// stamped when absent or zero, so a world-baked mesh decodes identically over
// every transport, and the two disjoint source ids are tested against
// `undefined` rather than for truthiness. The viewer keeps the tested copy at
// apps/viewer/src/utils/serverMesh.ts (issue #1841, #3199); keep yours in step.
function convertServerMesh(m: ServerMeshData): MeshData {
  return {
    expressId: m.express_id,
    ifcType: m.ifc_type,
    positions: new Float32Array(m.positions),
    normals: m.normals ? new Float32Array(m.normals) : new Float32Array(0),
    indices: new Uint32Array(m.indices),
    color: m.color,
    ...(m.origin?.some((v) => v !== 0) ? { origin: m.origin } : {}),
    ...(m.geometry_class ? { geometryClass: m.geometry_class } : {}),
    ...(m.geometry_item_id !== undefined ? { geometryItemId: m.geometry_item_id } : {}),
    ...(m.material_id !== undefined ? { materialId: m.material_id } : {}),
  };
}

for await (const event of client.parseStream(file)) {
  switch (event.type) {
    case 'progress':
      console.log(`${event.processed}/${event.total}`);
      break;
    case 'batch':
      renderer.addMeshes(
        event.meshes.map(convertServerMesh),
        true, // streaming: throttle batch rebuilds — first triangles ~300ms in
      );
      break;
    case 'complete':
      console.log(`Done: ${event.stats.total_meshes} meshes`);
      break;
    case 'error':
      console.error(event.message);
      break;
  }
}
```

## Health check + server info

```typescript
try {
  const info = await client.health();
  console.log(`Server v${info.version} (${info.status})`);
} catch {
  console.warn('Server unreachable, falling back to client-side parse');
}
```

## Lower-level: Parquet decoders

If you're consuming server responses outside the SDK (e.g. from a worker, or another runtime), the same Parquet/Arrow decoders are exposed directly:

```typescript
import { decodeParquetGeometry } from '@ifc-lite/server-client';

const meshes = await decodeParquetGeometry(arrayBuffer);
```

## API

See the [Server Guide](https://ifclite.dev/docs/guide/server/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-liteserver-client).

## License

[MPL-2.0](../../LICENSE)
