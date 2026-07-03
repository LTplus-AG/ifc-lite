---
"@ifc-lite/geometry": minor
---

`GeometryProcessor` now implements `[Symbol.dispose]()`, so `using processor = new GeometryProcessor(...)` frees the underlying WASM `IfcAPI` handle deterministically at scope exit. `dispose()` is no longer a no-op: it delegates to the same cleanup (`IfcLiteBridge.dispose()` -> `IfcAPI.free()`), fixing a real per-processor WASM handle leak on every one-shot export path (CSV/GLB/KMZ) that already called `dispose()` in a `finally` block expecting it to release the handle. Both paths are idempotent -- calling `dispose()` more than once, or combining an explicit call with the `using` scope exit, never double-frees the wasm-bindgen pointer.
