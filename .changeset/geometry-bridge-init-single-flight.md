---
"@ifc-lite/geometry": patch
---

`IfcLiteBridge.init()` (and so `GeometryProcessor.init()` on the WASM path) is now single-flight: overlapping `init()` calls share one attempt and build one `IfcAPI` handle instead of leaking the first. A `dispose()` that lands while `init()` is in flight now makes that `init()` reject ("superseded by dispose()") without building a handle, instead of leaving the bridge initialized after it was disposed. `dispose()` is not terminal: a later `init()` rebuilds the handle as before. A failed `init()` stays retryable, and recovery after a WASM trap (#1898) is unchanged.
