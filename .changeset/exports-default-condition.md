---
"@ifc-lite/bcf": patch
"@ifc-lite/cache": patch
"@ifc-lite/clash": patch
"@ifc-lite/cli": patch
"@ifc-lite/collab-server": patch
"@ifc-lite/collab": patch
"@ifc-lite/create": patch
"@ifc-lite/data": patch
"@ifc-lite/diff": patch
"@ifc-lite/drawing-2d": patch
"@ifc-lite/embed-protocol": patch
"@ifc-lite/embed-sdk": patch
"@ifc-lite/encoding": patch
"@ifc-lite/export": patch
"@ifc-lite/extensions": patch
"@ifc-lite/geometry": patch
"@ifc-lite/ids": patch
"@ifc-lite/ifcx": patch
"@ifc-lite/lens": patch
"@ifc-lite/lists": patch
"@ifc-lite/mcp": patch
"@ifc-lite/mutations": patch
"@ifc-lite/parser": patch
"@ifc-lite/pointcloud": patch
"@ifc-lite/query": patch
"@ifc-lite/renderer": patch
"@ifc-lite/sandbox": patch
"@ifc-lite/sdk": patch
"@ifc-lite/server-bin": patch
"@ifc-lite/server-client": patch
"@ifc-lite/spatial": patch
"@ifc-lite/viewer-core": patch
"@ifc-lite/wasm": patch
---

Add a `default` condition to every package's exports map. The maps only
declared `import` + `types`, so any resolver hitting the CJS/default
condition path (tsx, jest, plain `require`, some bundlers) failed with
ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
ESM dist file; pure ESM consumers are unaffected.
