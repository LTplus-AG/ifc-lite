# @ifc-lite/wasm

Pre-built WebAssembly bindings for the IFClite Rust core, covering STEP parsing and geometry tessellation (including the Manifold CSG kernel).

> **You probably don't need to use this package directly.** It's the WASM binary plus generated JS/TypeScript bindings that `@ifc-lite/parser`, `@ifc-lite/geometry`, and `@ifc-lite/renderer` consume internally. Reach for it when you want raw access to the Rust core without the higher-level wrappers.

## Installation

```bash
npm install @ifc-lite/wasm
```

## Direct WASM use

The text-based parse methods (`parse`, `parseStreaming`) take the raw IFC text
(a `string`) — decode the buffer first. The geometry methods (`buildPrePassOnce`,
`processGeometryBatch`, see below) instead take the raw `Uint8Array` bytes.

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

await init();                         // load and instantiate the WASM module

const api = new IfcAPI();
const buffer = await fetch('model.ifc').then(r => r.arrayBuffer());
const content = new TextDecoder().decode(buffer);

// Lightweight parse — returns { entityCount, ... }
const result = await api.parse(content);
console.log(`Entities: ${result.entityCount}`);

api.free();                           // free the API instance
```

## Meshes (pre-pass + job batches)

Geometry runs as a single pre-pass (one scan that produces a flat job list
plus unit scale, RTC offset, void/style indices) followed by
`processGeometryBatch` calls over slices of that job list. Pass the IFC
**bytes** (`Uint8Array`) to these methods:

```typescript
import init, { IfcAPI } from '@ifc-lite/wasm';

await init();
const api = new IfcAPI();
const bytes = new Uint8Array(await fetch('model.ifc').then(r => r.arrayBuffer()));

const pre = api.buildPrePassOnce(bytes);
// Large-coordinate models: pre.needsShift / pre.rtcOffset give the RTC origin.
for (let start = 0; start < pre.totalJobs; start += 100) {
  const end = Math.min(start + 100, pre.totalJobs);
  const jobs = pre.jobs.slice(start * 3, end * 3);
  const collection = api.processGeometryBatch(
    bytes, jobs, pre.unitScale,
    pre.rtcOffset?.[0] ?? 0, pre.rtcOffset?.[1] ?? 0, pre.rtcOffset?.[2] ?? 0,
    pre.needsShift,
    pre.voidKeys, pre.voidCounts, pre.voidValues,
    pre.styleIds, pre.styleColors,
  );
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    scene.add(toThreeMesh(mesh)); // mesh.expressId, .ifcType, .positions, .normals, .indices, .color
    mesh.free();
  }
  collection.free();
}

api.clearPrePassCache();
api.free();                           // release the API instance when done
```

> Most consumers should use [`@ifc-lite/geometry`](../geometry/README.md)'s
> `GeometryProcessor` instead — it wraps this pre-pass/job-batch flow with a
> Web-Worker pool, RTC coordinate handling, and progressive streaming.

## Exports

| Class | Purpose |
|---|---|
| `IfcAPI` | Top-level entry point — `parse`, `parseStreaming`, `buildPrePassOnce` / `buildPrePassFast` / `buildPrePassStreaming`, `processGeometryBatch`, `scanEntitiesFast` / `scanEntitiesFastBytes` / `scanGeometryEntitiesFast`, `extractProfiles`, `parseSymbolicRepresentations` |
| `MeshCollection`, `MeshDataJs` | Tessellated geometry output |
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

This package ships the bindings only. The Rust source lives in [`rust/wasm-bindings/`](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/wasm-bindings) and the core in [`rust/core/`](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/core). Available on crates.io as `ifc-lite-core`.

## API

See the [WASM API Reference](https://ltplus-ag.github.io/ifc-lite/api/wasm/).

## License

[MPL-2.0](https://mozilla.org/MPL/2.0/)
