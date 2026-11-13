---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Inline point clouds can carry a double-precision origin (#10029). `PointCloudAsset` has a new optional `origin` with the same contract as `MeshData.origin`: point i sits at `origin + chunk.positions[3i..3i+3]`, and `chunk.bbox` is relative to it. Before, a cloud at national-grid coordinates (x = 2,600,000 m in Swiss LV95) was held as absolute float32 and landed on a 0.25 m grid, so nearby points merged and the cloud drifted off the meshes beside it. The renderer uses the origin as the cloud's float64 placement, the same path a streamed scan's decode origin takes, so drawing, picking, snapping, measuring and fit-to-view keep millimetres. The federation's RTC re-base now moves a model's inline clouds with its meshes, through their origin, and the viewer's 2D scan section places them through it too. Apart from that re-base, which used to leave a mixed model's clouds behind in the old frame, a cloud without an origin behaves as before. IFCX clouds stay on absolute positions: the IFCX reader narrows to float32 before any origin could be split off, for meshes and clouds alike.
