---
"@ifc-lite/geometry": patch
---

Document the Vite `worker.format: 'es'` config requirement (the actual
root cause of #666 for geometry consumers — ESM workers are not Vite's
default and the package can't ship around that) and add an optional
`ProcessParallelOptions.wasmUrls` escape hatch so consumers whose
bundler doesn't transform `new URL('ifc-lite_bg.wasm', import.meta.url)`
inside the worker — or who serve the wasm from a different origin
(CDN, Tauri custom protocol, etc.) — can pass an explicit URL. The
workers forward it to wasm-bindgen's documented `init(url)` parameter.
Default behaviour is unchanged: Vite + webpack 5 consumers who already
worked continue to work without setting `wasmUrls`.
