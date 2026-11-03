---
"@ifc-lite/renderer": minor
---

Add `Camera.setLensShift(x, y)`, `getLensShift()` and `getActiveLensShift()`: a perspective lens shift (off-axis frustum) in NDC for two-point perspective. Picking, sections, overlays, cursor zoom, ambient occlusion, edge detection, the sky background and shadow focus follow the shift. Orthographic projection ignores it.
