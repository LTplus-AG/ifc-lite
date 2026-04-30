---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Point cloud rendering quality: splat pipeline + Eye-Dome Lighting.

The 1-pixel `point-list` rendering looked great from far away but turned
into a halftone screen as you zoomed in — `point-list` topology has no
`gl_PointSize` equivalent in WebGPU, so density was fixed in screen space.

This swaps the pipeline for instanced 6-vertex quad splats and adds a
post-pass EDL for depth perception.

**Splat pipeline**
- `topology: 'triangle-list'`, vertex buffer `stepMode: 'instance'`,
  6 verts emitted per source point. Vertex shader picks a corner from
  `vertex_index` and inflates clip-space position by the active size.
- Three size modes:
  - `fixed-px` — every splat is N pixels (1..20)
  - `adaptive-world` — splat covers a world-space radius, projected each
    frame; closer = bigger
  - `attenuated` (default) — adaptive but clamped to [1, N] px so splats
    stay visible at far plane and don't blow up to half the screen up close
- Round shape: fragment discards corners outside the unit disc, so splats
  render as discs not squares.

**Eye-Dome Lighting**
- New `EdlPass` runs after the existing PostProcessor. Samples 4 (low) or
  8 (high) neighbouring depths at radius R px, computes mean log-depth-
  diff, darkens by `1 - exp(-300 * meanLog * strength)`. ~9 texture taps
  per pixel. Only active when point clouds are loaded.
- Reverse-Z aware (`max(0, log(centre) - log(neighbour))`), early-out at
  the far plane.

**UI**
- `PointCloudPanel` gains size-mode buttons, a 1–20 px slider, a 1–100 mm
  world-radius slider (visible in adaptive/attenuated modes), and an EDL
  toggle with a 0–3 strength slider.
- New `pointCloudSlice` fields: `pointCloudSizeMode`, `pointCloudPointSize`,
  `pointCloudWorldRadius`, `pointCloudRoundShape`, `pointCloudEdlEnabled`,
  `pointCloudEdlStrength`. Slice clamps numeric ranges.

Renderer API additions: `setEdlOptions({enabled, strength, radiusPx,
highQuality})`. `setPointCloudOptions` now also accepts `sizeMode`,
`worldRadius`, `roundShape`.
