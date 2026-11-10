---
"@ifc-lite/wasm-lifecycle": minor
"@ifc-lite/geometry": minor
"@ifc-lite/clash": patch
---

Add `createLifetime` to `@ifc-lite/wasm-lifecycle`: single-flight init with `idle`, `initializing`, `ready`, `failed` and `disposed` states and a generation. Concurrent `init()` calls share one attempt, a failed one is retried, and a `dispose()` makes an in-flight attempt stale, so its success is released instead of resurrecting the resource and its failure never touches the attempt that replaced it. `IfcLiteBridge` and the clash wasm init now use it.

`GeometryProcessor` on the native (Tauri) path no longer builds a new platform bridge on every `init()` call: concurrent and repeated calls share one, `dispose()` now releases it (through the new optional `IPlatformBridge.dispose()`), an `init()` overtaken by `dispose()` rejects instead of installing its bridge, and a failed init is retried.
