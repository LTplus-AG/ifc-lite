---
"@ifc-lite/renderer": minor
---

Add `Camera.setLensShift(x, y)` / `getLensShift()`: a perspective lens shift (off-axis frustum) in NDC for two-point perspective. Picking, sections, overlays, cursor zoom, the sky background and shadow focus follow the shift; orthographic projection ignores it.
