---
"@ifc-lite/geometry": patch
"@ifc-lite/parser": patch
---

The WASM engine binary (`ifc-lite_bg.wasm`) is now downloaded resiliently and identifiably from every entry point.

`IfcLiteBridge.init()` — the main-thread initialisation, and the only self-fetching `init()` in the codebase that still lacked one — now runs through `initWasmWithRetry`, the same one-shot retry both the geometry and parser workers have used since #1363. A single blip on the ~1.3 MB engine download no longer fails the whole model load; a first-time visitor pulling the binary cold is the case this protects.

`initWasmWithRetry` also names the binary when the final failure names nothing. A network-level rejection propagates raw out of wasm-bindgen's loader — WebKit words it `TypeError: Load failed`, Chromium `TypeError: Failed to fetch` — with an empty stack, so neither the user-facing message nor error tracking could tell what had failed to load. Such a failure is now rethrown as `Failed to load the WASM engine binary (ifc-lite_bg.wasm) in <label>: <original>`, with the original preserved as `.cause`. Messages that already identify themselves (any `wasm` / `WebAssembly` phrasing, and failed module imports) are passed through byte-for-byte so the stale-deployment matchers keep working.

No public API surface changed.
