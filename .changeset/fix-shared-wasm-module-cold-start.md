---
"@ifc-lite/geometry": patch
---

fix(viewer): share compiled wasm module across workers to kill cold-start wait

Compile the geometry engine's `WebAssembly.Module` ONCE on the main thread and structured-clone that single compiled module to every geometry + pre-pass worker, which then `initSync` it (cheap) instead of each independently fetching and compiling the ~3.9 MB binary. Previously all N geometry workers plus the pre-pass worker called wasm-bindgen `init()`, so 4-5 parallel cold compiles of a multi-MB module contended on the CPU on a user's first load — producing a multi-second "WASM ready" stagger before any geometry appeared, and on large files enough startup latency to trip the geometry-stream stall watchdog. The worker already accepted a shared module but the path was dead code: it called `initSync({ module_or_path })` while wasm-bindgen's glue destructures `.module`, so it would have thrown `new WebAssembly.Module(undefined)` — and the host never sent a module. Uses `compileStreaming` (compile-while-download), caches the module for the session (federation/reload reuse it), and falls back to per-worker `init()` when the URL can't be resolved or compilation fails, so non-Vite consumers are unaffected. Geometry output is unchanged.
