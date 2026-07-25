---
"@ifc-lite/pointcloud": minor
"@ifc-lite/renderer": minor
---

Add IfcMapConversion alignment support for georeferenced point clouds (issue #1804).

`@ifc-lite/pointcloud`: `decodeLasPoints`, `LasStreamingSource`, `LazStreamingSource`, `streamPointCloud`, and the decode-worker protocol all gain an optional `originOffset` (native X/Y/Z) that is subtracted from each decoded LAS/LAZ coordinate in f64, before it is narrowed to f32. Georeferenced scans carry absolute map coordinates (~1e6-1e7 m); narrowing those to f32 first quantises to ~0.5-1 m before any alignment math sees them, defeating sub-metre alignment with an IFC model. All new fields are optional and additive — omitting them reproduces prior behaviour byte-for-byte.

`@ifc-lite/renderer`: `PointCloudNode` gains an optional per-asset `model` matrix (column-major, 16 floats), consumed by `writePointCloudUniforms` and settable via `PointCloudRenderer.setAssetTransform` / `Renderer.setPointCloudTransform`. Defaults to identity when absent, so existing point-cloud rendering is unchanged; this is the hook the viewer uses to toggle `IfcMapConversion` alignment on/off without re-streaming the scan. The matrix is honoured consistently across the whole point-cloud surface: `PointCloudRenderer.getBounds()` reports world-space (matrix-folded) extents (height-ramp colouring and scene framing agree with where points render), `Renderer.setPointCloudTransform` re-derives the scene bounds, and the BIM↔scan deviation compute pass transforms each point by the same matrix before its closest-triangle query, so deviations are measured in the frame the user sees.
