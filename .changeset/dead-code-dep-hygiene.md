---
'@ifc-lite/clash': patch
'@ifc-lite/collab': patch
'@ifc-lite/sdk': patch
'@ifc-lite/renderer': patch
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
'@ifc-lite/data': patch
---

Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.
