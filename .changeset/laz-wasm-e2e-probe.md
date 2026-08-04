---
"@ifc-lite/pointcloud": minor
---

Add `probeLazPerfWasmLoad()`, an internal E2E test hook that exercises the real laz-perf wasm loader (the Vite `?url` asset fetch plus the `Module.wasmBinary` hand-off to emscripten) without needing a `.laz` fixture. No other test drove this path for real: every existing test substitutes the loader via `setLazPerfLoaderForTesting()`, so a broken `?url` resolution or a broken `wasmBinary` hand-off stayed invisible until a real browser tried to open a LAZ file (#2097). Used by `apps/viewer`'s `laz-probe.html` (E2E-only, not linked from the app UI) and asserted by `tests/e2e/laz-wasm.e2e.spec.ts` against a real production build.
