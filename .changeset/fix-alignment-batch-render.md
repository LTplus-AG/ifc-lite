---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
---

Render `IfcAlignment` as a thin centerline **line** instead of a triangulated
ribbon, matching how IfcGrid axes and IfcAnnotation curves draw.

`IfcAlignment` carries its geometry in the `Axis` curve (`IfcAlignmentCurve` or
`IfcPolyline`), not a `Representation`. Previously the streaming batch mesher
routed it through the whole-element `IfcAlignmentProcessor`, which sampled the
directrix into a thin solid ribbon strip — visually wrong for what is a
centerline. Now the alignment is sampled straight into a line-list overlay:

- **`@ifc-lite/wasm`** gains `IfcAPI.parseAlignmentLines(content)`, which walks
  every `IfcAlignment`, resolves its `Axis` directrix, samples the centerline
  (1 file-unit station spacing, adaptive cap at 5000 samples) and returns a flat
  `Float32Array` of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in the
  renderer's Y-up, RTC-subtracted, metres world space — the same frame the mesh
  pipeline produces, so the line lands on the same ground as the terrain.
- **`@ifc-lite/geometry`** surfaces it as `GeometryProcessor.parseAlignmentLines`.
- **`@ifc-lite/renderer`** gains `uploadAlignmentLines3D` / `clearAlignmentLines3D`,
  drawing the centerline through the existing line pipeline (separate buffer).

The batch mesher no longer special-cases `IfcAlignment` into the ribbon
processor (reverted to the prior skip), so alignments are lines-only — never
both. In the viewer the centerline renders whenever a model carries an
alignment (no toggle).

Regression coverage: `alignment_lines` unit tests in
`rust/wasm-bindings/src/api/alignment_lines.rs` pin the contract — a planar
polyline alignment emits an even-count line-list whose start maps to the
renderer origin and whose extent matches the directrix, and a file with no
alignment emits an empty array.
