---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Add an opt-in threaded-WASM geometry path (in-instance rayon, shared memory).

`@ifc-lite/wasm` gains a `./threaded` subpath export for the `pkg-threaded` bundle
(built off by default via `BUILD_THREADED=1 ./scripts/build-wasm.sh`; exports
`initThreadPool`). `@ifc-lite/geometry` adds `wasm-features` runtime detection
(`supportsWasmThreads` / `isThreadedWasmUsable`) plus the wiring: the geometry
worker dynamic-imports the threaded glue and brings up the rayon pool once, and
the parallel orchestrator runs ONE shared-memory worker (whose internal
`par_chunks` element loop fans CSG across cores) instead of the N single-thread
worker pool. The default single-thread path is untouched.

Off by default. The path is selected only when `globalThis.__IFCLITE_THREADED_WASM__`
is `true` AND the page is cross-origin isolated. Browser A/B showed it is a win on
CSG-bound models and a tie on large decode-bound models, with exact output parity;
it stays opt-in until a threaded-failure fallback lands and production data confirms
the per-model win.
