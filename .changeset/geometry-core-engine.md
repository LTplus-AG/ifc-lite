---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

A smaller engine for pages that only mesh IFC. `@ifc-lite/wasm/core` (binary: `@ifc-lite/wasm/core_bg.wasm`) is the engine built without the exporters, LandXML, clash detection, point-cloud scan operations and PDF underlays; parsing, mesh streaming, styles and the 2D helpers are the same code, and every fixture meshes to identical bytes. Swap it in with an exact bundler alias of `@ifc-lite/wasm` to `@ifc-lite/wasm/core` (Vite: `{ find: /^@ifc-lite\/wasm$/, replacement: '@ifc-lite/wasm/core' }`); see the Geometry Processing guide. Both engine glues now export `ENGINE_BINARY_URL` (`null` for the full engine), and `@ifc-lite/geometry` compiles that binary for its shared module, so the aliased core glue is never handed the full binary. Without the alias nothing changes.
