---
"@ifc-lite/wasm": patch
---

Every from-bytes GLB export in the `ifc-lite-export` Rust crate now refuses a model with nothing to render (#4685). `try_export_glb_streaming_bounded` and `try_export_glb_streaming_bounded_with_index` returned a zero-mesh GLB as success on an empty visible set, although the `try_` prefix reads as fail-closed; that GLB is not valid glTF (`accessors`, `bufferViews`, `meshes` and `nodes` are empty arrays where the schema requires at least one item, and `buffers[0].byteLength` is 0). They now return `ExportError::NoRenderGeometry`, decided after the first pass so an empty model no longer pays for the second meshing pass.

The fail-open from-bytes entry points are removed in favour of their `try_` twins: `export_glb` (use `try_export_glb`), `export_glb_with_stats` (use `try_export_glb_with_stats`), `export_glb_streaming_bounded` and `export_glb_streaming_bounded_with_index` (use the `try_` versions, which also return `ExportError::TooLarge` where these panicked). `export_glb_with_stats_with_index` is renamed `try_export_glb_with_stats_with_index` and returns a `Result`. This is a Rust API break that rides the pending crate major; the wasm `exportGlb` binding already called `try_export_glb` and behaves as before.
