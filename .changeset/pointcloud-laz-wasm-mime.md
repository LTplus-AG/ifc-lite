---
"@ifc-lite/pointcloud": patch
"@ifc-lite/viewer": patch
---

Fix LAZ load failing with `WebAssembly: Response has unsupported MIME
type 'text/plain'` on real-world files (e.g. autzen-classified.laz).

`laz-perf`'s emscripten shim resolves the wasm via `locateFile()` and
calls `fetch("laz-perf.wasm")` relative to its own script directory.
In a Vite-bundled module worker that path becomes `/assets/<chunk>/…`
or just `/laz-perf.wasm` — both 404, and the SPA fallback returns
`index.html` as `text/plain`, which `instantiateStreaming` rightly
rejects. The async fallback then 404s the same way and aborts.

`loadLazPerf` now resolves the wasm asset URL through Vite's
`?url` import (`laz-perf/lib/web/laz-perf.wasm?url`), pre-fetches the
bytes itself, and hands them to emscripten as `Module.wasmBinary` so
the shim's own fetch is bypassed entirely. Failure modes (asset
resolution, fetch HTTP error) now produce a precise error message
naming the URL and status instead of the opaque emscripten "Aborted".
