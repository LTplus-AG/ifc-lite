---
"@ifc-lite/geometry": minor
---

A WebAssembly runtime trap no longer bricks every geometry consumer in the document.

`IfcLiteBridge` used to store one `Error` in a module-level global the first time any operation trapped, and then throw that same object from every subsequent `init()` for the rest of the page's life. Because the global is per-realm, a trap in one consumer (a GLB export, say) disabled every other main-thread consumer — the next model load, the grid and drawing meshers, all the other exporters — even though the trap could only ever have damaged the engine handle that took it. The stored object also carried the stack of the call that first trapped, so the error reported later, from an unrelated call, was undiagnosable.

Now:

- A trap taken by an *operation* drops (and `free()`s — it used to leak) only the `IfcAPI` handle that took it, and propagates unchanged to the caller. Any later `init()`, on that bridge or another, builds a fresh handle and works.
- A trap taken while *initializing* is the one unrecoverable case: this realm has no working engine, and neither half is retryable in practice (a trap in `new IfcAPI()` leaves the module singleton already built, a trap in instantiation is deterministic). It is reported as a freshly constructed error whose message carries the stable `WASM_RUNTIME_UNRECOVERABLE` marker and the underlying trap verbatim, with the trap as `cause`, and it dispatches `WASM_RUNTIME_UNRECOVERABLE_EVENT` on `globalThis` so the host can offer the user a reload. The library never reloads the page itself.

New exports: `isWasmRuntimeTrap`, `isWasmRuntimeUnrecoverableError`, `WASM_RUNTIME_UNRECOVERABLE_CODE`, `WASM_RUNTIME_UNRECOVERABLE_EVENT`.
