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

## License

[MPL-2.0](../../LICENSE)
