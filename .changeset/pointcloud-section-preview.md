---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Section-plane drag preview — render at 1/4 density during slider
drag for responsive section-cutting on huge point clouds.

The splat shader gains a `previewStride` uniform that culls
`(instance_index % stride) != 0` at the start of `vs_main`. The
section-plane position slider wires `onPointerDown` to set
`previewStride: 4` and `onPointerUp` to restore `1`, so scans of
millions of points stay responsive while the user drags.

Implementation:
- `POINT_UNIFORM_SIZE` bumped from 208 → 224 to add a new
  `extras: vec4<u32>` slot. `extras.x` carries `previewStride`;
  `yzw` reserved for future per-frame state.
- `PointCloudRenderOptions.previewStride?: number` clamped to
  [1, 256] in the renderer.
- Vertex shader culls hidden instances by writing
  `clipPos = vec4(0, 0, -2, 1)` (outside reverse-Z `[0, 1]`) so they
  drop pre-rasterisation.
- New `pointCloudPreviewStride` field on the point cloud slice
  (default 1) with `setPointCloudPreviewStride` action.
- `usePointCloudSync` forwards the stride to
  `setPointCloudOptions`.
- `SectionOverlay`'s position slider triggers stride 4 on
  drag start (pointer + keyboard), 1 on release. Only flips when
  `pointCloudAssetCount > 0` so IFC-only sessions are unaffected.

Triangle meshes ignore the stride — they're cheap enough that
section drag was already smooth.

Verified: full repo typecheck (24/24), 655 viewer tests, viewer
Vite build green.
