# @ifc-lite/geometry

Streaming geometry processor for IFClite. Converts IFC bytes to renderable mesh batches via Rust + WASM (or Tauri native), with first triangles in 300–500ms and progressive streaming for large models.

## Installation

```bash
npm install @ifc-lite/geometry
```

## Process geometry from IFC bytes

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';

const processor = new GeometryProcessor();
await processor.init();

const buffer = new Uint8Array(await file.arrayBuffer());
const result = await processor.process(buffer);

console.log(`${result.meshes.length} meshes, ${result.totalTriangles} triangles`);
// Each mesh: { expressId, positions: Float32Array, normals, indices: Uint32Array, color, ifcType }
```

## Stream geometry (recommended for large models)

```typescript
for await (const event of processor.processStreaming(buffer)) {
  if (event.type === 'batch') {
    renderer.appendMeshes(event.meshes);
    console.log(`Loaded ${event.totalSoFar} meshes so far`);
  } else if (event.type === 'complete') {
    console.log(`Done: ${event.totalMeshes} meshes`);
  }
}
```

The streaming path emits batches every ~100 meshes so the renderer can paint progressively — first triangles typically arrive 300–500ms after `processStreaming()` returns.

## Coordinate handling

```typescript
import { CoordinateHandler } from '@ifc-lite/geometry';

const result = await processor.process(buffer);

// Models with large world coordinates (geo-referenced) get auto-shifted
// to keep float precision inside the renderer.
if (result.coordinateInfo?.hasLargeCoordinates) {
  const { x, y, z } = result.coordinateInfo.originShift;
  console.log(`Origin shifted by [${x}, ${y}, ${z}] for renderer precision`);
}
```

## Performance

- **First triangles:** 300–500ms (streaming path)
- **Throughput:** up to 5× faster than `web-ifc` on the same model
- **Worker support:** files > 50 MB process off-main-thread automatically
- **Native (Tauri):** `preferNative: true` constructor option enables the native Rust pipeline for desktop builds

## API

See the [Geometry Guide](https://louistrue.github.io/ifc-lite/guide/geometry/) and [API Reference](https://louistrue.github.io/ifc-lite/api/typescript/#ifc-litegeometry).

## License

[MPL-2.0](../../LICENSE)
