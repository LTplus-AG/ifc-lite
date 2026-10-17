---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
"@ifc-lite/export": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/viewer": patch
---

OBJ and USD exports of a model with nothing to draw now fail instead of writing an empty file. This is how GLB export already behaved.

A model with no render geometry, or one whose filters hide every mesh, used to export as a header-only OBJ or a USD stage with no meshes. Both were reported as successful. `exportObj` and `exportUsd` now throw an `Error` whose message starts with `NO_RENDER_GEOMETRY`, the same error `exportGlb` throws, so `isNoRenderGeometryError` matches all three. The rest of the stack handles the error:

- **CLI:** `ifc-lite export --format obj|usd` exits with "produced 0 vertices" or "produced 0 meshes" and writes no file.
- **MCP:** the `export_obj` and `export_usd` tools return that message as a tool error.
- **Viewer:** the USD dialog shows that message instead of the raw engine error.

Data formats are unchanged. CSV, JSON, JSON-LD, IFCX, STEP, HBJSON and DFJSON still export a model without geometry, because an empty table or graph is still a valid document.

`@ifc-lite/export` adds `countUsdMeshes`, the USD counterpart of `countObjVertices` and `countGlbMeshes`.

In the Rust crate, `export_gltf_streaming`, `export_gltf_streaming_with_index`, `export_obj`, `export_obj_with_stats` and `export_usd` now return `Result<_, ExportError>`.
