---
'@ifc-lite/wasm': minor
'@ifc-lite/geometry': minor
'@ifc-lite/cli': minor
'@ifc-lite/mcp': minor
---

Export Rhino .3dm from the CLI (`--format 3dm`) and MCP (`export_3dm`). The scene builder ships as the separate `@ifc-lite/wasm/rhino` payload, loaded by `@ifc-lite/geometry`'s `exportRhinoScene` on first use, so the default engine wasm does not grow.
