---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Inline point clouds can carry a double-precision origin (#10029). `PointCloudAsset` has a new optional `origin` with the same contract as `MeshData.origin`: point i sits at `origin + chunk.positions[3i..3i+3]`, and `chunk.bbox` is relative to it. Before, a cloud at national-grid coordinates (x = 2,600,000 m in Swiss LV95) was absolute float32 and landed on a 0.25 m grid. The renderer uses the origin as the cloud's float64 placement, the path a streamed scan's decode origin already takes, so drawing, picking, snapping and fit-to-view keep millimetres. The viewer's 2D scan section places the cloud through it too, and the federation's RTC re-base now moves a model's inline clouds with its meshes instead of leaving them in the old frame. Otherwise a cloud without an origin behaves as before. IFCX clouds stay absolute: the IFCX reader narrows to float32 before an origin could be split off.
