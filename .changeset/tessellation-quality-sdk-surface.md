---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

Expose the consumer-configurable tessellation quality (#976) on the SDK/WASM surface. `IfcAPI.setTessellationQuality('lowest' | 'low' | 'medium' | 'high' | 'highest')` selects the detail level applied by every subsequent `processGeometryBatch` call, and `@ifc-lite/geometry`'s `GeometryProcessor` accepts a `tessellationQuality` constructor option plus a `setTessellationQuality()` runtime setter that forward the level to the main-thread, streaming and worker-pool WASM paths. Unset / `'medium'` reproduces the engine's historical densities byte-for-byte, so existing consumers see no change; lower levels coarsen curved geometry for throughput, higher levels reduce faceting on pipes / cylinders / NURBS at a proportional triangle-count cost.
