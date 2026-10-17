---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/export": patch
"@ifc-lite/viewer": patch
---

GLB, LOD1, Parquet and IFC5 exports of a georeferenced model now land at the model's world position instead of in the viewer's shifted render frame.

The viewer shifts a large-coordinate model toward the origin (an RTC offset) so the GPU keeps its f32 precision. Exports built from those shifted meshes dropped the shift, so the file came out kilometres from where the same model lands through the from-bytes exporters.

- **GLB (`exportGlbFromMeshes`):** takes an optional `worldMatrix`, the column-major 4x4 that carries the baked frame back to IFC world (a rigid transform). The GLB root carries it, as the from-bytes export already does. `renderFrameWorldMatrix(coordinateInfo)` in `@ifc-lite/geometry/world-frame` builds it. The viewer's GLB export and LOD1 pass it. A matrix that is not 16 finite numbers, or not a rotation plus a translation, throws `MALFORMED_MESH_INPUT`.
- **Parquet (.bos):** vertices stay in the render frame. `Metadata.json` now records `meshCoordinateSpace`, `vertexAxes` and `worldTransform` (`world = M * [x, y, z, 1]`), the keys the Rust BOS writer already uses.
- **IFC5:** the mesh points are written in IFC world, in f64.
- **Server models in the viewer:** the server's `origin_shift` is in IFC Z-up axes but was read as Y-up, so the reconstructed `originalBounds` of an RTC model mixed axes. It is converted at the boundary now.
- **KMZ altitude:** the KML altitude now folds back the whole render-frame offset (the Y-up `originShift` as well as the wasm RTC Z), so a server-loaded RTC model exported with "True elevation" is no longer placed at its shifted height.
