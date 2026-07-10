---
"@ifc-lite/renderer": minor
---

Contribution culling + frame/GPU-memory stats (issue #1682 observability).

- New opt-in `RenderOptions.contributionCull`: skip colour batches whose world AABB projects below a pixel threshold (raised while the camera moves). Conservative bounding-sphere math; never culls when the camera is inside a batch's bounds. Off by default.
- New `Renderer.getFrameStats()`: draw calls issued plus batches drawn / frustum-culled / contribution-culled for the last completed frame.
- New `Scene.getResidentGpuBytes()`: byte-accurate sum of GPU buffers held by colour batches, partial sub-batches, hydrated meshes, textured meshes and instanced templates.
