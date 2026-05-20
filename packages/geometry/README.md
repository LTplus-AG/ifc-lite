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

## Vite setup

The geometry workers ship as ESM and use the standard
`new Worker(new URL('./geometry.worker.js', import.meta.url), { type: 'module' })`
spawn pattern. Vite's default `worker.format: 'iife'` setting can't host
ESM workers, so consumers need one config line:

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
});
```

This is the same contract that Mapbox-GL, Three.js, Cesium, and Monaco
require — ESM workers are not the Vite default, but they are the modern
standard and the pattern wasm-bindgen produces by default.

If your bundler can't transform
`new URL('ifc-lite_bg.wasm', import.meta.url)` inside the worker bundle
(or you serve the wasm from a CDN at a separate origin), pass explicit
wasm URLs through the `processAdaptive` / `processParallel` `wasmUrls`
option:

```ts
// Vite's `?url` suffix yields a fully-resolved URL string at build time.
// `@ifc-lite/wasm` and `@ifc-lite/wasm-threaded` both expose the binary
// at the `./ifc-lite_bg.wasm` subpath so this resolves cleanly through
// the package's `exports` map.
import wasmUrl from '@ifc-lite/wasm/ifc-lite_bg.wasm?url';

for await (const event of processor.processAdaptive(buffer, {
  wasmUrls: { wasm: wasmUrl },
})) { /* ... */ }
```

The worker forwards the URL to wasm-bindgen's documented `init(url)`
parameter, bypassing the default `new URL(..., import.meta.url)`
resolution inside the worker entirely. For webpack 5 use
`new URL('@ifc-lite/wasm/ifc-lite_bg.wasm', import.meta.url).href`;
for other bundlers, any string the runtime can resolve to the binary
works.

## Performance

- **First triangles:** 300–500ms (streaming path)
- **Throughput:** up to 5× faster than `web-ifc` on the same model
- **Worker support:** files > 50 MB process off-main-thread automatically
- **Native (Tauri):** `preferNative: true` constructor option enables the native Rust pipeline for desktop builds

## API

See the [Geometry Guide](https://ltplus-ag.github.io/ifc-lite/guide/geometry/) and [API Reference](https://ltplus-ag.github.io/ifc-lite/api/typescript/#ifc-litegeometry).

## License

[MPL-2.0](../../LICENSE)
