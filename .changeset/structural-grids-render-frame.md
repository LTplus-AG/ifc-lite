---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

feat(grids): expose structural grids (IfcGrid/IfcGridAxis) in the render frame (#945)

Resolve `IfcGridAxis` curves through the same placement + unit-scale + RTC
pipeline the meshes use and emit them in the renderer's Y-up, RTC-subtracted,
metres world frame, so structural grids overlay streamed geometry by
construction (no viewer re-implements the placement resolver).

- New WASM API `parseGridLines(content) -> Float32Array` (flat 3D line-list)
  and `parseGridAxes(content) -> GridAxisCollection` (structured per-axis
  `{ gridId, axisId, tag, start, end }`), mirroring `parseAlignmentLines`.
- New `@ifc-lite/geometry` `GeometryProcessor.parseGridLines` /
  `parseGridAxes` (returns plain `GridAxis[]`) and a `GridAxis` type.
- `CoordinateInfo` now also reports `lengthUnitScale` and populates
  `wasmRtcOffset` (the actually-applied RTC offset) directly from the geometry
  pipeline, so any consumer can map externally-resolved geometry into the
  render frame without viewer-side patching.
