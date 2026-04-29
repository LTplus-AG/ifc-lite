# @ifc-lite/wasm

Pre-built WebAssembly bindings for the IFClite Rust core. ~650 KB binary (~260 KB gzipped) covering STEP parsing, geometry tessellation, georeferencing, and zero-copy GPU upload.

> **You probably don't need to use this package directly.** It's the WASM binary plus generated JS/TypeScript bindings that `@ifc-lite/parser`, `@ifc-lite/geometry`, and `@ifc-lite/renderer` consume internally. Reach for it when you want raw access to the Rust core without the higher-level wrappers.

## Installation

```bash
npm install @ifc-lite/wasm
```

## Direct WASM use

`IfcAPI` methods take the raw IFC text (a `string`), not a `Uint8Array`. Decode the buffer first.

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

await init();                         // load and instantiate the WASM module

const api = new IfcAPI();
const buffer = await fetch('model.ifc').then(r => r.arrayBuffer());
const content = new TextDecoder().decode(buffer);

// Lightweight parse — returns { entityCount, ... }
const result = await api.parse(content);
console.log(`Entities: ${result.entityCount}`);

// Tessellated meshes — each entry has expressId, positions, indices, normals, color
const meshes = api.parseMeshes(content);
console.log(`${meshes.length} meshes`);
for (let i = 0; i < meshes.length; i++) {
  const mesh = meshes.get(i);
  console.log(mesh.ifcType, mesh.expressId, mesh.vertexCount, 'vertices');
}

meshes.free();                        // free the Rust-side mesh buffer
api.free();                           // free the API instance
```

## Streaming mesh batches

For progressive rendering, stream meshes in batches and yield to the browser between them:

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

await init();
const api = new IfcAPI();

await api.parseMeshesAsync(content, {
  batchSize: 100,
  onRtcOffset: ({ x, y, z, hasRtc }) => {
    if (hasRtc) viewer.setWorldOffset(x, y, z);
  },
  onBatch: (meshes, progress) => {
    for (const mesh of meshes) scene.add(toThreeMesh(mesh));
    console.log(`${progress.percent}%`);
  },
  onComplete: ({ totalMeshes }) => console.log(`Done — ${totalMeshes} meshes`),
});
```

## Zero-copy GPU upload

`parseToGpuGeometry` returns interleaved (position + normal) vertex data with pointers into WASM linear memory, ready for direct `GPUBuffer` upload:

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

await init();
const api = new IfcAPI();
const gpuGeom = api.parseToGpuGeometry(content);
const memory = api.getMemory();

// Direct views into WASM memory — no intermediate copy
const vertexView = new Float32Array(memory.buffer, gpuGeom.vertexDataPtr, gpuGeom.vertexDataLen);
const indexView = new Uint32Array(memory.buffer, gpuGeom.indicesPtr, gpuGeom.indicesLen);

device.queue.writeBuffer(gpuVertexBuffer, 0, vertexView);
device.queue.writeBuffer(gpuIndexBuffer, 0, indexView);

// IMPORTANT: views are only valid until the next WASM allocation. Free immediately after upload.
gpuGeom.free();
```

For deduplicated geometry (one mesh per shape, per-instance transforms), use `parseToGpuInstancedGeometry(content)` and iterate `GpuInstancedGeometryCollection`.

## Georeferencing

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

await init();
const api = new IfcAPI();
const georef = api.getGeoReference(content);

if (georef) {
  console.log(`CRS: ${georef.crsName}`);
  const [e, n, h] = georef.localToMap(10, 20, 5);
  console.log(`Local (10,20,5) → Map (${e}, ${n}, ${h})`);
  georef.free();
}
```

## Exports

| Class | Purpose |
|---|---|
| `IfcAPI` | Top-level parser entry point — `parse`, `parseMeshes`, `parseMeshesAsync`, `parseToGpuGeometry`, `parseZeroCopy`, `getGeoReference`, `extractProfiles`, `parseSymbolicRepresentations`, … |
| `MeshCollection`, `MeshDataJs` | Tessellated geometry output |
| `MeshCollectionWithRtc`, `RtcOffsetJs` | Mesh collection with relative-to-centre offset for large-coordinate models |
| `InstancedMeshCollection`, `InstancedGeometry`, `InstanceData` | Instanced geometry path (deduplicated meshes + per-instance transforms) |
| `ZeroCopyMesh`, `GpuGeometry`, `GpuMeshMetadata` | Zero-copy GPU upload handles |
| `GpuInstancedGeometry`, `GpuInstancedGeometryCollection`, `GpuInstancedGeometryRef` | Zero-copy instanced path |
| `GeoReferenceJs` | Georeferencing transform |
| `ProfileCollection`, `ProfileEntryJs` | Cross-section profile data (extruded-area solids) |
| `SymbolicRepresentationCollection`, `SymbolicCircle`, `SymbolicPolyline` | 2D symbolic representations (for plan / annotation views) |

All classes implement `free()` and `[Symbol.dispose]()` — call `free()` (or use `using`) to release Rust-side memory.

## When to use a higher-level package instead

| You want… | Use |
|---|---|
| A typed, idiomatic TS API for parsing | [`@ifc-lite/parser`](../parser/README.md) |
| Streaming geometry with worker support | [`@ifc-lite/geometry`](../geometry/README.md) |
| WebGPU rendering | [`@ifc-lite/renderer`](../renderer/README.md) |
| To avoid managing WASM lifecycles by hand | Any of the above |

## Rust source

This package ships the bindings only. The Rust source lives in [`rust/wasm-bindings/`](https://github.com/louistrue/ifc-lite/tree/main/rust/wasm-bindings) and the core in [`rust/core/`](https://github.com/louistrue/ifc-lite/tree/main/rust/core). Available on crates.io as `ifc-lite-core`.

## API

See the [WASM API Reference](https://louistrue.github.io/ifc-lite/api/wasm/).

## License

[MPL-2.0](https://mozilla.org/MPL/2.0/)
