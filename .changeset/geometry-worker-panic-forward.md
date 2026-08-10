---
"@ifc-lite/geometry": patch
"@ifc-lite/parser": patch
---

Forward a geometry/parser worker's wasm panic-location stash to the main thread.

A follow-up to the wasm-trap source-location attribution: the Rust panic hook stashes
`{ location, at }` on whichever realm's JS global it runs in, but a panic inside a geometry
process worker or the parser worker left that stash stranded in the worker's own realm, invisible
to the main thread's `attachWasmPanicLocation` gate — so "Geometry worker error: unreachable" (and
the equivalent parser-worker error) still arrived without a location.

Both workers now read + consume their own realm's stash on the `{type:'error'}` message they post
back, and the main-thread pools (`geometry-parallel.ts`, `worker-parser.ts`) re-plant it on the main
realm's global before the load error propagates — so the existing consume-once, TTL-guarded
attachment gate in the viewer picks a worker trap up exactly as it would a main-thread one. Location
only, never the panic message, matching the existing privacy contract.
