---
"@ifc-lite/geometry": patch
---

Fix a WASM handle leak in `IfcLiteBridge.init()`: the `IfcAPI` handle is constructed at `new IfcAPI()` and then four cached settings (`applyMergeLayers`, `applyComputeGeometryHashes`, `applyTessellationQuality`, `applySkipSmallCuts`) are replayed onto it before `init()` marks itself ready. If any of those four throws, the `catch` block called `reset()`, which only nulled the JS reference — it never called `free()` on the handle that had just been built, so the wasm-bindgen pointer leaked for the life of the document (no later `dispose()` can reach a `null` handle).

`init()`'s failure path now best-effort frees the handle before dropping the reference, on both the ordinary-error and the fatal WASM-runtime-trap branches — the same "drop (and free) the handle, propagate the error unchanged" contract every other WASM-calling method in this file already follows via `recordWasmRuntimeTrap`. The free is wrapped so a secondary failure from `free()` itself (the runtime can re-trap while freeing) can never replace or mask the original `init()` error reaching the caller.

Not changed: what happens when the WASM trap occurs before the handle exists (during module instantiation) — there is nothing to free in that case, and the fatal error/reload-advisory behavior for that path is unchanged.
