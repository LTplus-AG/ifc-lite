# @ifc-lite/pointcloud

Renderer-agnostic point cloud decoders for ifc-lite. Phase 0 covers the three
IFCx pointcloud schemas authored by buildingSMART:

- `pcd::base64` — full PCD file (PCL format) embedded as base64. Supports
  ASCII, binary, and LZF-compressed `binary_compressed` payloads.
- `points::array` — inline JSON `{ positions: number[][], colors?: number[][] }`.
- `points::base64` — `{ positions: base64-Float32, colors?: base64-Float32 }`.

```ts
import { decodeIfcxPointAttribute } from '@ifc-lite/pointcloud';

const chunk = decodeIfcxPointAttribute(node.attributes);
if (chunk) {
  console.log(`${chunk.pointCount} points`, chunk.bbox);
  // chunk.positions, chunk.colors are ready for GPU upload
}
```

The renderer (`@ifc-lite/renderer`) consumes `DecodedPointChunk` values via
`Renderer.loadPointClouds()` / `Renderer.addPointCloudChunks()`.

## Streaming decode worker (zero Vite config)

For streaming sources (`.las`, `.laz`, `.ply`, `.pcd`, `.e57`, `.pts`, `.xyz`)
the decoder runs in a dedicated Web Worker so the main thread stays
responsive. The worker is **inlined into the published package** as a
`Blob`-URL — consumers don't need to set `worker.format: 'es'` or add the
package to `optimizeDeps.exclude` in their Vite config.

```ts
import { createDecodeWorkerSource } from '@ifc-lite/pointcloud';

const source = createDecodeWorkerSource({ format: 'las', blob: file });
const info = await source.open();
// drive source.next(maxPoints) → DecodedPointChunk until it returns null
```

Notes:

- The inlined worker bundle is lazy-loaded — consumers that only call
  `decodeIfcxPointAttribute` (the non-worker decoder) don't pay the bytes.
- LAZ decoding (`format: 'laz'`) pulls in `laz-perf`'s wasm at runtime via
  `new URL(..., import.meta.url)`, which doesn't resolve from inside a
  `Blob`-URL worker. If you need LAZ from the published package, pass a
  custom `spawn` callback that yields a worker capable of fetching the
  wasm (see `DecodeWorkerOptions.spawn`).
- Strict CSPs need `script-src 'self' blob:` to allow the `Blob`-URL
  worker.

## License

[MPL-2.0](../../LICENSE)
