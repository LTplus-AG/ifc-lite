---
"@ifc-lite/geometry": minor
---

Detect and broadcast the "stale deployment" WASM-asset failure so hosts can recover from version skew. When a production deploy rotates the content-hashed `ifc-lite_bg-<hash>.wasm` under a still-open tab, the lazy fetch 404s (served as `text/plain`) and `WebAssembly.instantiateStreaming` throws `Response has unsupported MIME type 'text/plain' … expected 'application/wasm'` — the engine never initializes (#1363). A same-URL retry can't recover a rotated asset, so the geometry engine now classifies this case (`isWasmAssetUnavailableError`) and dispatches a `WASM_ASSET_UNAVAILABLE_EVENT` on `globalThis` at its init choke points (the main-thread `GeometryProcessor.init` and the worker-pool error handlers). The library never reloads the page itself; an opted-in host (the viewer) listens and reloads once onto the current deployment.
