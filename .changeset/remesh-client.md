---
"@ifc-lite/geometry": minor
---

Add `@ifc-lite/geometry/remesh` (#6232): `RemeshClient` runs one long-lived wasm worker that re-meshes edited elements from a subgraph buffer (`serializeEntitySubgraph` in `@ifc-lite/export`). Each request goes through the load path's own calls, `buildPrePassOnce`, then `processGeometryBatch` over only the target jobs, then `convertMeshCollectionToBatch`. It uses the model's saved RTC frame and load-time style wire, and the pre-pass cache is released on every exit. `RemeshConfig` carries the toggles that change mesh output (merge layers, tessellation quality, small-cut skip, rectangular-opening fast path), so re-meshed geometry matches the load. `dispose()` terminates the worker and rejects requests still in flight. `filterStyleWire` narrows the style wire to a subgraph's ids. The load path itself is unchanged.
