# @ifc-lite/pointcloud

Renderer-agnostic point cloud decoders for ifc-lite. Phase 0 covers the three
IFCx pointcloud schemas authored by buildingSMART:

- `pcd::base64` — full PCD file (PCL format) embedded as base64. Supports
  ASCII, binary, and LZF-compressed `binary_compressed` payloads.
- `points::array` — inline JSON `{ positions: number[][], colors?: number[][] }`.
- `points::base64` — `{ positions: base64-Float32, colors?: base64-Float32 }`.

## Installation

```bash
npm install @ifc-lite/pointcloud
```

## Decode IFCX point attributes

```ts
import { decodeIfcxPointAttribute } from '@ifc-lite/pointcloud';

// One IFCX node's attribute map, e.g. from a parsed .ifcx document
declare const node: { attributes: ReadonlyMap<string, unknown> };

const chunk = decodeIfcxPointAttribute(node.attributes);
if (chunk) {
  console.log(`${chunk.pointCount} points`, chunk.bbox);
  // chunk.positions, chunk.colors are ready for GPU upload
}
```

`DecodedPointChunk.normals` carries source-supplied oriented normals as
row-aligned `nx, ny, nz` float triples when a decoder provides them. PLY
supports complete `nx`/`ny`/`nz` properties in ASCII and binary files and
preserves their values and vertex order exactly. A partial normal declaration
is rejected; consumers decide whether finite, nonzero normals are required for
their operation.

The canonical PLY streaming source scans headers and bounds in bounded byte
windows, then decodes directly into host-sized, stride-filtered chunks. A
memory-cap probe therefore does not allocate full-file point channels before
downsampling. Streaming PLY headers are limited to 65,536 bytes and files that
exceed that bound are refused with an explicit error.

The renderer (`@ifc-lite/renderer`) uploads decoded chunks (wrapped as
`PointCloudAsset` values) via `Renderer.setPointClouds()` /
`Renderer.addPointClouds()`.

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

## API

See the [docs site](https://ifclite.dev/docs/) for guides and the full API reference.

## License

[MPL-2.0](../../LICENSE)


## Local origins for large-coordinate scans

`streamPointCloud({ ..., autoOrigin: true })` chooses a nearby origin before
emitting chunks when `originOffset` is absent. Header bounds choose the centre;
formats without usable bounds probe one point and reopen the original bytes.
The decoder subtracts that origin in float64 before writing float32 positions.
`onOpen(info)` receives the chosen `info.originOffset` in native X/Y/Z source
units, before the first `onChunk`. Compose that offset with your alignment and
manual translation in double precision before sending a final matrix to the
GPU. Explicit `originOffset` takes precedence; the default remains unchanged.
Opening may perform an extra decode pass for formats without header bounds.
A local origin preserves nearby detail but cannot repair a source whose
coordinates were already quantized or an extremely large spatial extent.
