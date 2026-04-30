---
"@ifc-lite/pointcloud": minor
"@ifc-lite/geometry": minor
"@ifc-lite/ifcx": minor
"@ifc-lite/parser": minor
"@ifc-lite/renderer": minor
---

Phase 0 of full point cloud loading: render the buildingSMART IFCx
pointcloud samples (`pcd::base64`, `points::array`, `points::base64`).

- New `@ifc-lite/pointcloud` package: renderer-agnostic decoders for PCD
  (ASCII / binary / binary_compressed via inline LZF) and the two inline
  IFCx point schemas. Pure TS, no three.js, no WebGPU.
- `@ifc-lite/geometry` adds `PointCloudAsset` and `GeometryResult.pointClouds`.
- `@ifc-lite/ifcx` adds `extractPointClouds()` and surfaces decoded scans
  on `IfcxParseResult.pointClouds`. The mesh extractor is unchanged.
- `@ifc-lite/parser` re-exports the new `PointCloudExtraction` type.
- `@ifc-lite/renderer` gains a WGSL `topology: 'point-list'` pipeline,
  per-asset GPU buffers, and `Renderer.setPointClouds()` /
  `Renderer.addPointClouds()`. Points share the depth buffer and section
  plane state with the triangle pipeline.
