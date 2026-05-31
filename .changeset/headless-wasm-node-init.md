---
"@ifc-lite/geometry": patch
---

Make WASM geometry init work in a headless Node runtime.

`@ifc-lite/wasm` is built for wasm-bindgen's `web` target, whose default
initializer fetches the binary from `new URL('ifc-lite_bg.wasm', import.meta.url)`.
Node's `fetch` cannot read `file://` URLs, so `GeometryProcessor.init()` threw in
every headless context — the CLI, the MCP server, and SDK scripts.

That broke clash detection through MCP in particular: `clash_check` /
`clash_matrix` mesh the model via `GeometryProcessor` before running the engine,
so when init failed the agent silently fell back to `geometry_bbox` (bounding
boxes) instead of real, triangle-accurate clash results.

`IfcLiteBridge.init()` now detects a headless Node runtime, reads the
`@ifc-lite/wasm` binary off disk (resolved through the package's
`./ifc-lite_bg.wasm` export), and hands the bytes to the initializer. The
browser path is untouched (it still uses the default fetch loader). This makes
clash detection a first-class citizen across the CLI, SDK scripts, and the MCP
server — all of which route their meshing through this one entry point.
