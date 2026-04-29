# @ifc-lite/wasm

Pre-built WebAssembly bindings for the IFClite Rust core. ~650 KB binary (~260 KB gzipped) covering STEP parsing, geometry tessellation, georeferencing, and zero-copy GPU upload.

> **You probably don't need to use this package directly.** It's the WASM binary plus generated JS/TypeScript bindings that `@ifc-lite/parser`, `@ifc-lite/geometry`, and `@ifc-lite/renderer` consume internally. Reach for it when you want raw access to the Rust core without the higher-level wrappers.

## Installation

```bash
npm install @ifc-lite/wasm
```

## Direct WASM use

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

await init();                    // load and instantiate the WASM module

const api = new IfcAPI();
const buffer = new Uint8Array(await file.arrayBuffer());

// Parse a STEP file — returns a parse handle the other methods key off
const handle = api.parse(buffer);

console.log(`Schema: ${api.getSchemaVersion(handle)}`);
console.log(`Entities: ${api.getEntityCount(handle)}`);

// Process geometry — returns a MeshCollection with TypedArray vertex buffers
const meshes = api.processGeometry(handle);
console.log(`${meshes.length} meshes`);

api.dispose(handle);              // free the Rust-side parse state
```

## Zero-copy GPU upload

The bindings expose handles into WASM linear memory so you can pump vertex data straight into a `GPUBuffer` without intermediate copies:

```typescript
import init, { ZeroCopyMesh, IfcAPI } from '@ifc-lite/wasm';

await init();

const api = new IfcAPI();
const handle = api.parse(buffer);
const zcMeshes = api.processGeometryZeroCopy(handle);

for (let i = 0; i < zcMeshes.length; i++) {
  const mesh: ZeroCopyMesh = zcMeshes.get(i);

  // Direct view into WASM memory — no allocation, no copy
  const vertices = mesh.vertexView();   // Float32Array
  const indices = mesh.indexView();     // Uint32Array

  device.queue.writeBuffer(gpuVertexBuffer, 0, vertices);
  device.queue.writeBuffer(gpuIndexBuffer, 0, indices);
}
```

## Georeferencing

```typescript
import init, { GeoReferenceJs } from '@ifc-lite/wasm';

await init();

const api = new IfcAPI();
const handle = api.parse(buffer);
const georef: GeoReferenceJs | null = api.getGeoReference(handle);

if (georef) {
  console.log(`CRS: ${georef.crsName}`);
  const [e, n, h] = georef.localToMap(10, 20, 5);
  console.log(`Local (10,20,5) → Map (${e}, ${n}, ${h})`);
}
```

## Exports

| Class | Purpose |
|---|---|
| `IfcAPI` | Top-level parser entry point |
| `MeshCollection`, `MeshDataJs` | Tessellated geometry output |
| `InstancedMeshCollection`, `InstancedGeometry`, `InstanceData` | Instanced geometry path (deduplicated meshes + per-instance transforms) |
| `ZeroCopyMesh`, `GpuGeometry`, `GpuMeshMetadata` | Zero-copy GPU upload handles |
| `GpuInstancedGeometry`, `GpuInstancedGeometryCollection` | Zero-copy instanced path |
| `RtcOffsetJs` | Relative-to-centre offset for large-coordinate models |
| `GeoReferenceJs` | Georeferencing transform |
| `ProfileCollection`, `ProfileEntryJs` | Cross-section profile data |
| `SymbolicRepresentationCollection`, `SymbolicCircle`, `SymbolicPolyline` | 2D symbolic representations (for plan / annotation views) |

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
