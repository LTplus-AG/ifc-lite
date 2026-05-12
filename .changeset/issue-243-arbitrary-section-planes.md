---
"@ifc-lite/renderer": minor
"@ifc-lite/drawing-2d": minor
"@ifc-lite/viewer": minor
---

Arbitrary-normal section planes with face-pick (Bonsai-style) and a
properly-rendered cap on tilted planes (#243). Click any face in the
section tool's "Pick" mode to cut through it; the kept half-space
defaults to the side facing the camera. The cardinal "Down / Front /
Side" presets are unchanged.

Renderer:

- New `planeBasis(normal)` + `nearestCardinalAxis(normal)` exports
  derive a deterministic in-plane basis used by both the cap renderer
  and the 2D cutter — without a single shared derivation the cap hatch
  rotated when state was reconstructed.
- `SectionPlaneRenderOptions` and `SectionPlane` gain optional
  `normal` + `distance` fields. When set, the shader clips on that
  plane verbatim (no axis mapping, no building-rotation, no
  position-percentage math) and the gizmo renders as a violet quad
  oriented from `planeBasis(normal)`.
- `Section2DOverlayRenderer.uploadDrawing` accepts an optional
  `customPlane = { origin, tangent, bitangent }`. When supplied it
  replaces the cardinal-axis 2D→3D coordinate swap with
  `origin + tangent·x + bitangent·y`, so the cap silhouette lands
  exactly on the tilted plane (the bug PR #581 hid by suppressing the
  cap entirely for non-cardinal planes).

Drawing-2d:

- `SectionPlaneConfig` gains an optional `customPlane`. `SectionCutter`
  uses it verbatim for the plane equation and projects intersections
  to 2D via `(dot(p − origin, tangent), dot(p − origin, bitangent))`,
  matching the cap renderer's lift exactly.
- `DrawingGenerator` now rebuilds the CPU cutter on each `generate()`
  call so a switch from cardinal to custom (or between custom planes)
  takes effect immediately.

Tests: 11 new viewer tests covering normalisation, sign-preserving
cardinal mapping, basis orthonormality, half-space flip, slice
clearing on cardinal preset, and degenerate-normal handling. 6 new
renderer tests covering basis derivation across cardinal axes,
near-axis tilts, and the +Y / −Y reference-axis boundary.
