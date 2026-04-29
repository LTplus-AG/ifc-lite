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
console.log(`${result.entities.length} entities, ${result.meshes.length} meshes`);
```

## Stream a large file

```typescript
const ac = new AbortController();

for await (const event of client.parseStream(file, { signal: ac.signal })) {
  switch (event.type) {
    case 'progress':
      console.log(`${event.phase}: ${event.percent}%`);
      break;
    case 'batch':
      renderer.appendMeshes(event.meshes); // first triangles ~300ms in
      break;
    case 'complete':
      console.log(`Done: ${event.totalMeshes} meshes`);
      break;
    case 'error':
      console.error(event.error);
      break;
  }
}

// Cancel mid-stream
// ac.abort();
```

## Health check + server info

```typescript
const info = await client.getServerInfo();
console.log(`Server v${info.version}, ${info.cpuCores} cores, ${info.cacheStats.entries} cached files`);

const ok = await client.ping();
if (!ok) console.warn('Server unreachable — falling back to client-side parse');
```

## Lower-level: Parquet decoders

If you're consuming server responses outside the SDK (e.g. from a worker, or another runtime), the same Parquet/Arrow decoders are exposed directly:

```typescript
import { decodeParquetResponse } from '@ifc-lite/server-client';

const meshes = await decodeParquetResponse(arrayBuffer);
```

## API

See the [Server Guide](../../docs/guide/server.md) and [API Reference](../../docs/api/typescript.md#ifc-liteserver-client).

## License

[MPL-2.0](../../LICENSE)
