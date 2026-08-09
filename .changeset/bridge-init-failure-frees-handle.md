---
"@ifc-lite/geometry": patch
---

Free the `IfcAPI` handle when `IfcLiteBridge.init()` fails after allocating it ([#2342](https://github.com/LTplus-AG/ifc-lite/issues/2342)).

`init()` constructs `new IfcAPI()` and then makes four `apply*()` calls — `setMergeLayers`, `setComputeGeometryHashes`, `setTessellationQuality`, `setSkipSmallCuts` — that each reach into WASM. So "init failed" does not imply "nothing was allocated": any of those four throwing (a trap, or the engine rejecting a value) lands in the catch with a live handle. That catch called `reset()`, which nulls `ifcApi` without freeing it, and `dispose()` is the only route to `free()` in the class — so the wasm-bindgen pointer, and the whole per-load pre-pass / entity / style cache set behind it, was stranded with no remaining reference for the lifetime of the realm.

The class already documented the correct recovery for the operation-trap path (`recordWasmRuntimeTrap`: dispose, and fall back to `reset()` if `free()` itself traps, so a secondary failure cannot replace the error already on its way to the caller). Both paths now share it. The comment claiming there is "no `IfcAPI` to drop" when init trapped is corrected — it is true only for a trap raised before `new IfcAPI()`.

This is the layer the [#2389](https://github.com/LTplus-AG/ifc-lite/pull/2389) reorder of `packages/mcp/src/tools/export.ts` deliberately left alone: that change made `dispose()` reachable on the failure path, but the handle was already nulled by then, so the free still never happened. The fix here is in the bridge, so it holds for every consumer regardless of whether the caller reaches its own `dispose()`.

No behaviour change on the dominant failure. A missing or rotated WASM binary throws before `new IfcAPI()`, where the optional chain in `dispose()` makes this identical to the previous `reset()`.
