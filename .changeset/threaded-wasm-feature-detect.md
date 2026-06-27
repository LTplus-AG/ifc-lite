---
"@ifc-lite/geometry": patch
---

Add `wasm-features` runtime detection (`supportsWasmThreads` / `isThreadedWasmUsable`)
— the gate for selecting the threaded WASM geometry bundle (`pkg-threaded`) when
the engine supports the threads proposal and the page is cross-origin isolated,
falling back to the single-thread bundle otherwise. Detection + tests only; the
bundle-selection wiring (threaded worker variant + orchestration) follows once
verified against the running viewer.
